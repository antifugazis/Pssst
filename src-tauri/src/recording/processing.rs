use std::{fs, io::Write, path::PathBuf, thread, time::Duration};
use anyhow::{Context, Result}; use reqwest::blocking::{multipart, Client}; use serde::{Deserialize, Serialize}; use uuid::Uuid;
use crate::capture::TrackKind; use super::{LocalTranscriptSegment, RecordingState, SessionStore, TrackProcessingState};
const CHUNK_SECONDS: usize = 25; const WAV_HEADER: usize = 44; const BYTES_PER_SECOND: usize = 48_000 * 2 * 2;
#[derive(Clone, Serialize, Deserialize)] struct Queue { items: Vec<QueueItem> }
#[derive(Clone, Serialize, Deserialize)] struct QueueItem { sequence: usize, start_ms: i64, end_ms: i64, path: String, state: String, attempts: u32, last_error: Option<String> }

/// One worker per session. It only reads completed windows; capture keeps sole ownership of the live track.
pub fn spawn_processing(store: SessionStore, id: Uuid) { let _ = thread::Builder::new().name(format!("pssst-processing-{id}")).spawn(move || { let mut failures = 0u32; loop { let live = store.load(&id).map(|s| s.recording_state == RecordingState::Recording).unwrap_or(false); match process_once(&store, id, !live) { Ok(()) => failures = 0, Err(error) => { failures = failures.saturating_add(1); eprintln!("pssst processing: {error:#}"); } } if !live { break; } thread::sleep(Duration::from_secs(2u64.saturating_pow(failures.min(4)))); } }); }
pub fn resume_pending(store: SessionStore) {
    let directory = store.root().join("sessions");
    if let Ok(entries) = fs::read_dir(directory) {
        for entry in entries.flatten() {
            if let Ok(id) = Uuid::parse_str(&entry.file_name().to_string_lossy()) {
                if let Ok(session) = store.load(&id) {
                    if session.transcript_segments.is_empty() && session.recording_state == RecordingState::Stopped {
                        spawn_processing(store.clone(), id);
                    }
                }
            }
        }
    }
}

/// Trigger a one-shot correction pass for a session. Used by the
/// "Corriger la transcription" button in the Detail view. Correction runs
/// locally on the desktop — it calls OpenRouter directly with the user's own
/// API key and stores corrected text in the local manifest. The Whisper server
/// is not involved in correction at all.

const CORRECTION_PROMPT: &str = "Tu corriges une transcription automatique de cours universitaire en français.\nDétermine ce que le professeur a réellement dit, sans améliorer sa manière de parler.\nCorrige uniquement les erreurs probables de reconnaissance vocale. Conserve hésitations,\nrépétitions, faux départs, expressions orales et grammaire parlée. Ne reformule pas, ne\nrésume pas, n'ajoute aucune information et ne corrige pas les faits. Quand une notation\ntechnique est clairement dictée, écris-la normalement (free tiret h → free -h, égal égal → ==).\nSi c'est incertain, conserve le texte. Retourne uniquement la transcription corrigée.\nLe texte t'est envoyé ligne par ligne, une ligne par segment. Retourne exactement le même\nnombre de lignes, dans le même ordre, une correction par ligne.";

pub fn run_correction(store: &SessionStore, id: Uuid) -> Result<()> {
    let (api_key, model) = openrouter_config(store).context("OpenRouter is not configured. Save your API key and model in Settings.")?;
    let session = store.load(&id)?;
    if session.transcript_segments.is_empty() {
        anyhow::bail!("No transcript segments to correct yet");
    }

    let mut updated = session.clone();
    updated.correction_state = TrackProcessingState::Uploading;
    updated.last_error = None;
    store.save(&updated)?;

    // Group segments into ~45s windows so the model gets enough context while updating frequently.
    let batch_ms = 45_000i64;
    let mut groups: Vec<Vec<usize>> = Vec::new();
    for (i, seg) in updated.transcript_segments.iter().enumerate() {
        match groups.last() {
            Some(current) if seg.start_ms - updated.transcript_segments[current[0]].start_ms < batch_ms => {
                groups.last_mut().unwrap().push(i);
            }
            _ => groups.push(vec![i]),
        }
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()?;

    for group in &groups {
        let raw_lines: Vec<&str> = group.iter().map(|&i| updated.transcript_segments[i].raw_text.as_str()).collect();
        let joined = raw_lines.join("\n");
        let body = serde_json::json!({
            "model": model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": CORRECTION_PROMPT},
                {"role": "user", "content": format!("Transcription brute:\n{joined}")}
            ]
        });
        let response = match client
            .post("https://openrouter.ai/api/v1/chat/completions")
            .header("Authorization", format!("Bearer {api_key}"))
            .json(&body)
            .send()
        {
            Ok(res) => res,
            Err(err) => {
                updated.correction_state = TrackProcessingState::Failed;
                updated.last_error = Some(err.to_string());
                let _ = store.save(&updated);
                return Err(err.into());
            }
        };

        if !response.status().is_success() {
            let msg = format!("OpenRouter returned HTTP {}: {}", response.status(), response.text().unwrap_or_default());
            updated.correction_state = TrackProcessingState::Failed;
            updated.last_error = Some(msg.clone());
            let _ = store.save(&updated);
            anyhow::bail!("{msg}");
        }

        let result: serde_json::Value = response.json()?;
        let mut corrected_joined = result["choices"][0]["message"]["content"]
            .as_str()
            .context("OpenRouter returned no content")?
            .trim()
            .to_string();
        // Strip common prefixes the model adds despite instructions.
        for prefix in ["Transcription corrigée :", "Transcription corrigée:", "Transcription corrigée", "Voici la transcription corrigée :"] {
            if let Some(rest) = corrected_joined.strip_prefix(prefix) {
                corrected_joined = rest.trim().to_string();
                break;
            }
        }
        let corrected_lines: Vec<&str> = corrected_joined.lines().collect();
        if corrected_lines.len() == group.len() {
            for (j, &i) in group.iter().enumerate() {
                updated.transcript_segments[i].corrected_text = Some(corrected_lines[j].trim().to_string());
                updated.transcript_segments[i].final_text = Some(corrected_lines[j].trim().to_string());
            }
        } else {
            // Line count mismatch: distribute what we can, keep raw for the rest.
            // This avoids dumping the whole batch into one segment (which causes
            // duplication when the other segments fall back to raw text).
            for (j, &i) in group.iter().enumerate() {
                if j < corrected_lines.len() {
                    updated.transcript_segments[i].corrected_text = Some(corrected_lines[j].trim().to_string());
                    updated.transcript_segments[i].final_text = Some(corrected_lines[j].trim().to_string());
                } else {
                    // Keep raw text as the corrected text so there's no duplication.
                    let raw = updated.transcript_segments[i].raw_text.clone();
                    updated.transcript_segments[i].corrected_text = Some(raw.clone());
                    updated.transcript_segments[i].final_text = Some(raw);
                }
            }
        }

        // Save immediately after each chunk completes so UI updates procedurally
        store.save(&updated)?;
    }

    updated.correction_state = TrackProcessingState::Uploaded;
    store.save(&updated)?;
    Ok(())
}

fn process_once(store: &SessionStore, id: Uuid, finalizing: bool) -> Result<()> { let session = store.load(&id)?; let source = store.track_path(&session, TrackKind::Application)?; let mut queue = refresh_queue(store, id, &source, finalizing)?; let (base, secret) = server_connection(store)?; let client = Client::builder().timeout(Duration::from_secs(120)).default_headers({ let mut h=reqwest::header::HeaderMap::new(); h.insert(reqwest::header::AUTHORIZATION, format!("Bearer {secret}").parse()?); h }).build()?; client.post(format!("{base}/v1/sessions/{id}")).send()?.error_for_status()?;
for index in 0..queue.items.len() { if queue.items[index].state == "complete" { continue; } queue.items[index].attempts += 1; queue.items[index].state = "uploading".into(); save(store,id,&queue)?; let item = queue.items[index].clone(); match upload(&client,&base,id,&item) { Ok(()) => { queue.items[index].state="complete".into(); queue.items[index].last_error=None; save(store,id,&queue)?; sync(&client,&base,store,id)?; }, Err(error) => { queue.items[index].state="retry".into(); queue.items[index].last_error=Some(error.to_string()); save(store,id,&queue)?; let mut s=store.load(&id)?; s.transcription_state=TrackProcessingState::Failed; s.last_error=queue.items[index].last_error.clone(); store.save(&s)?; return Err(error); } } }
let mut s=store.load(&id)?; s.transcription_state=TrackProcessingState::Uploaded; store.save(&s)?; Ok(()) }
fn refresh_queue(store:&SessionStore,id:Uuid,source:&PathBuf,finalizing:bool)->Result<Queue>{let path=store.queue_path(&id);let mut queue=if path.exists(){serde_json::from_slice(&fs::read(&path)?)?}else{Queue{items:vec![]}};let data=fs::read(source)?;if data.len()<=WAV_HEADER{return Ok(queue)};let payload=&data[WAV_HEADER..];let bytes=if finalizing{payload.len()}else{payload.len()/ (CHUNK_SECONDS*BYTES_PER_SECOND)*(CHUNK_SECONDS*BYTES_PER_SECOND)};let dir=source.parent().context("track parent")?.join("chunks");fs::create_dir_all(&dir)?;for(sequence,part)in payload[..bytes].chunks(CHUNK_SECONDS*BYTES_PER_SECOND).enumerate(){if queue.items.iter().any(|item|item.sequence==sequence){continue}let target=dir.join(format!("{sequence:06}.wav"));wav(&target,part)?;queue.items.push(QueueItem{sequence,start_ms:(sequence*CHUNK_SECONDS*1000)as i64,end_ms:((sequence*CHUNK_SECONDS*1000)+(part.len()*1000/BYTES_PER_SECOND))as i64,path:target.to_string_lossy().into(),state:"queued".into(),attempts:0,last_error:None});}queue.items.sort_by_key(|item|item.sequence);save(store,id,&queue)?;Ok(queue)}
fn wav(path:&PathBuf,data:&[u8])->Result<()> {let mut f=fs::File::create(path)?;let ch=2u16;let rate=48_000u32;let bits=16u16;let br=rate*ch as u32*bits as u32/8;let align=ch*bits/8;f.write_all(b"RIFF")?;f.write_all(&(36+data.len()as u32).to_le_bytes())?;f.write_all(b"WAVEfmt ")?;f.write_all(&16u32.to_le_bytes())?;f.write_all(&1u16.to_le_bytes())?;f.write_all(&ch.to_le_bytes())?;f.write_all(&rate.to_le_bytes())?;f.write_all(&br.to_le_bytes())?;f.write_all(&align.to_le_bytes())?;f.write_all(&bits.to_le_bytes())?;f.write_all(b"data")?;f.write_all(&(data.len()as u32).to_le_bytes())?;f.write_all(data)?;f.sync_all()?;Ok(())}
fn upload(c:&Client,b:&str,id:Uuid,item:&QueueItem)->Result<()>{let f=fs::File::open(&item.path)?;let form=multipart::Form::new().part("audio",multipart::Part::reader(f).file_name(format!("{}.wav",item.sequence)));c.post(format!("{b}/v1/sessions/{id}/chunks/{}",item.sequence)).multipart(form).send()?.error_for_status()?;c.post(format!("{b}/v1/sessions/{id}/chunks/{}/transcribe",item.sequence)).send()?.error_for_status()?;Ok(())}
fn sync(c:&Client,b:&str,store:&SessionStore,id:Uuid)->Result<()>{#[derive(Deserialize)]struct Row{id:String,start_ms:i64,end_ms:i64,raw_text:String,corrected_text:Option<String>,final_text:Option<String>}let rows:Vec<Row>=c.get(format!("{b}/v1/sessions/{id}/transcript")).send()?.error_for_status()?.json()?;let mut s=store.load(&id)?;for row in rows{if !s.transcript_segments.iter().any(|x|x.backend_id==row.id){s.transcript_segments.push(LocalTranscriptSegment{backend_id:row.id,start_ms:row.start_ms,end_ms:row.end_ms,raw_text:row.raw_text,corrected_text:row.corrected_text,final_text:row.final_text});}}s.transcript_segments.sort_by_key(|x|x.start_ms);store.save(&s)?;Ok(())}
fn save(store:&SessionStore,id:Uuid,q:&Queue)->Result<()>{let path=store.queue_path(&id);let temp=path.with_extension("tmp");fs::write(&temp,serde_json::to_vec_pretty(q)?)?;fs::rename(temp,path)?;Ok(())}
fn server_connection(store: &SessionStore) -> Result<(String, String)> {
    let link = std::env::var("PSSST_CONNECTION_LINK")
        .or_else(|_| fs::read_to_string(store.root().join("server-connection.txt")))
        .context("No pssst connection link configured")?;
    let (base, secret) = link.trim().rsplit_once("/connect/").context("Invalid pssst connection link")?;
    if secret.len() < 32 { anyhow::bail!("Invalid pssst connection link") }
    Ok((base.trim_end_matches('/').into(), secret.into()))
}

#[derive(Deserialize)]
struct OpenRouterConfig { api_key: Option<String>, model: Option<String> }

fn openrouter_config(store: &SessionStore) -> Option<(String, String)> {
    let path = store.root().join("openrouter-config.json");
    let data = fs::read_to_string(&path).ok()?;
    let config: OpenRouterConfig = serde_json::from_str(&data).ok()?;
    let key = config.api_key.filter(|k| !k.is_empty())?;
    let model = config.model.filter(|m| !m.is_empty())?;
    Some((key, model))
}
