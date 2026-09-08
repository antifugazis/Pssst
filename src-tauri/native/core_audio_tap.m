#import <AudioToolbox/AudioToolbox.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>
#import <libproc.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef struct {
    AudioObjectID tap;
    AudioObjectID aggregate;
    AudioUnit unit;
    AudioDeviceIOProcID ioProc;
    FILE *file;
    uint64_t bytes;
    BOOL processTap;
    BOOL usesDeviceIO;
    AudioStreamBasicDescription sourceFormat;
} PssstCapture;

// `ps` is deliberately not used for the picker. A packaged/macOS-sandboxed
// process can receive a restricted process view from it, which made Pssst
// appear to have only one open app. NSWorkspace is the system API that backs
// the user's actual running-app list.
int pssst_audio_list_applications(char *buffer, size_t length) {
    if (!buffer || length < 3) return -1;
    @autoreleasepool {
        NSMutableArray *items = [NSMutableArray array];
        void (^collect)(void) = ^{
            // NSWorkspace is AppKit state. Reading it from Tauri's command
            // worker can return an incomplete list; collect on the AppKit
            // main thread so this mirrors the Finder/Dock's app inventory.
            for (NSRunningApplication *application in NSWorkspace.sharedWorkspace.runningApplications) {
                if (application.terminated || application.activationPolicy != NSApplicationActivationPolicyRegular) continue;
                NSString *name = application.localizedName;
                NSString *bundleID = application.bundleIdentifier;
                if (!name.length || !bundleID.length || application.processIdentifier <= 0) continue;
                if ([bundleID isEqualToString:@"com.irisla.pssst.desktop"]) continue;
                [items addObject:@{ @"pid": @(application.processIdentifier), @"name": name, @"bundle_id": bundleID }];
            }
        };
        if (NSThread.isMainThread) collect(); else dispatch_sync(dispatch_get_main_queue(), collect);
        NSError *jsonError = nil;
        NSData *json = [NSJSONSerialization dataWithJSONObject:items options:0 error:&jsonError];
        if (!json || json.length + 1 > length) return -1;
        memcpy(buffer, json.bytes, json.length);
        buffer[json.length] = '\0';
        return 0;
    }
}

static void set_error(char *buffer, size_t length, const char *message) {
    if (!buffer || length == 0) return;
    snprintf(buffer, length, "%s", message ? message : "Core Audio error");
}

static void set_status_error(char *buffer, size_t length, const char *prefix, OSStatus status) {
    if (!buffer || length == 0) return;
    snprintf(buffer, length, "%s (OSStatus %d)", prefix, (int)status);
}

static void write_wav_header(FILE *file, uint32_t dataLength, uint32_t sampleRate, uint16_t channels) {
    if (sampleRate == 0) sampleRate = 48000;
    if (channels == 0) channels = 2;
    uint32_t riffLength = 36u + dataLength;
    uint16_t format = 1; // PCM signed integer
    uint16_t bits = 16;
    uint16_t blockAlign = channels * bits / 8;
    uint32_t byteRate = sampleRate * blockAlign;
    fseek(file, 0, SEEK_SET);
    fwrite("RIFF", 1, 4, file); fwrite(&riffLength, 4, 1, file); fwrite("WAVE", 1, 4, file);
    fwrite("fmt ", 1, 4, file); uint32_t fmtLength = 16; fwrite(&fmtLength, 4, 1, file);
    fwrite(&format, 2, 1, file); fwrite(&channels, 2, 1, file); fwrite(&sampleRate, 4, 1, file);
    fwrite(&byteRate, 4, 1, file); fwrite(&blockAlign, 2, 1, file); fwrite(&bits, 2, 1, file);
    fwrite("data", 1, 4, file); fwrite(&dataLength, 4, 1, file); fseek(file, 0, SEEK_END);
}

static void write_pcm_from_buffers(PssstCapture *capture, const AudioBufferList *buffers) {
    if (!capture || !capture->file || !buffers || buffers->mNumberBuffers == 0) return;
    const UInt32 channels = capture->sourceFormat.mChannelsPerFrame ? capture->sourceFormat.mChannelsPerFrame : 2;
    const BOOL sourceIsFloat = (capture->sourceFormat.mFormatFlags & kAudioFormatFlagIsFloat) != 0;

    if (buffers->mNumberBuffers == 1) {
        const AudioBuffer *buffer = &buffers->mBuffers[0];
        if (!buffer->mData || buffer->mDataByteSize == 0) return;
        if (!sourceIsFloat && capture->sourceFormat.mBitsPerChannel == 16) {
            fwrite(buffer->mData, 1, buffer->mDataByteSize, capture->file);
            capture->bytes += buffer->mDataByteSize;
            return;
        }
        const float *samples = (const float *)buffer->mData;
        const UInt32 sampleCount = buffer->mDataByteSize / sizeof(float);
        for (UInt32 sample = 0; sample < sampleCount; sample++) {
            const float value = samples[sample] < -1.0f ? -1.0f : (samples[sample] > 1.0f ? 1.0f : samples[sample]);
            const int16_t pcm = (int16_t)(value * 32767.0f);
            fwrite(&pcm, sizeof(pcm), 1, capture->file);
        }
        capture->bytes += (uint64_t)sampleCount * sizeof(int16_t);
        return;
    }

    UInt32 frames = UINT32_MAX;
    for (UInt32 channel = 0; channel < channels && channel < buffers->mNumberBuffers; channel++) {
        frames = MIN(frames, buffers->mBuffers[channel].mDataByteSize / (sourceIsFloat ? sizeof(float) : sizeof(int16_t)));
    }
    if (frames == UINT32_MAX) return;
    for (UInt32 frame = 0; frame < frames; frame++) {
        for (UInt32 channel = 0; channel < channels && channel < buffers->mNumberBuffers; channel++) {
            const AudioBuffer *buffer = &buffers->mBuffers[channel];
            int16_t pcm = 0;
            if (sourceIsFloat) {
                const float value = ((const float *)buffer->mData)[frame];
                const float clipped = value < -1.0f ? -1.0f : (value > 1.0f ? 1.0f : value);
                pcm = (int16_t)(clipped * 32767.0f);
            } else {
                pcm = ((const int16_t *)buffer->mData)[frame];
            }
            fwrite(&pcm, sizeof(pcm), 1, capture->file);
        }
    }
    capture->bytes += (uint64_t)frames * channels * sizeof(int16_t);
}

static OSStatus render_callback(void *refCon, AudioUnitRenderActionFlags *flags,
                                const AudioTimeStamp *timestamp, UInt32 bus,
                                UInt32 frames, AudioBufferList *ioData) {
    (void)ioData;
    PssstCapture *capture = (PssstCapture *)refCon;
    if (!capture || !capture->file || frames == 0) return noErr;

    UInt32 byteSize = frames * 2 * sizeof(float);
    float stackBuffer[4096 * 2];
    float *sampleBuffer = (frames <= 4096) ? stackBuffer : (float *)malloc(byteSize);
    if (!sampleBuffer) return noErr;

    AudioBufferList bufferList;
    bufferList.mNumberBuffers = 1;
    bufferList.mBuffers[0].mNumberChannels = 2;
    bufferList.mBuffers[0].mDataByteSize = byteSize;
    bufferList.mBuffers[0].mData = sampleBuffer;

    OSStatus status = AudioUnitRender(capture->unit, flags, timestamp, bus, frames, &bufferList);
    if (status == noErr) write_pcm_from_buffers(capture, &bufferList);

    if (sampleBuffer != stackBuffer) {
        free(sampleBuffer);
    }
    return status;
}

static BOOL is_descendant_of(pid_t pid, pid_t target_root) {
    if (pid <= 0 || target_root <= 0) return NO;
    if (pid == target_root) return YES;
    pid_t current = pid;
    for (int depth = 0; depth < 10; depth++) {
        struct proc_bsdinfo info;
        if (proc_pidinfo(current, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) <= 0) break;
        if ((pid_t)info.pbi_ppid == target_root || (pid_t)info.pbi_pgid == target_root) return YES;
        if (info.pbi_ppid <= 1 || (pid_t)info.pbi_ppid == current) break;
        current = (pid_t)info.pbi_ppid;
    }
    return NO;
}

static NSArray<NSNumber *> *process_objects_for_app(pid_t root_pid) {
    NSMutableArray *result = [NSMutableArray array];
    AudioObjectPropertyAddress address = { kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, NULL, &size) != noErr || size == 0) return result;
    UInt32 count = size / sizeof(AudioObjectID);
    AudioObjectID *objects = malloc(size);
    if (!objects) return result;
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, objects) != noErr) { free(objects); return result; }

    char root_path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    proc_pidpath(root_pid, root_path, sizeof(root_path));
    NSString *rootBundle = nil;
    NSString *rootPathStr = [NSString stringWithUTF8String:root_path];
    NSRange appRange = [rootPathStr rangeOfString:@".app" options:NSCaseInsensitiveSearch | NSBackwardsSearch];
    if (appRange.location != NSNotFound) {
        rootBundle = [rootPathStr substringToIndex:appRange.location + appRange.length];
    }

    for (UInt32 i = 0; i < count; i++) {
        AudioObjectPropertyAddress pidAddress = { kAudioProcessPropertyPID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
        pid_t candidate = 0; UInt32 pidSize = sizeof(candidate);
        if (AudioObjectGetPropertyData(objects[i], &pidAddress, 0, NULL, &pidSize, &candidate) == noErr && candidate > 0) {
            BOOL matches = (candidate == root_pid) || is_descendant_of(candidate, root_pid);
            if (!matches && rootBundle) {
                char cand_path[PROC_PIDPATHINFO_MAXSIZE] = {0};
                if (proc_pidpath(candidate, cand_path, sizeof(cand_path)) > 0) {
                    NSString *candPathStr = [NSString stringWithUTF8String:cand_path];
                    if ([candPathStr hasPrefix:rootBundle]) {
                        matches = YES;
                    }
                }
            }
            if (matches) {
                [result addObject:@(objects[i])];
            }
        }
    }
    free(objects);
    return result;
}

static NSString *default_output_uid(void) {
    AudioDeviceID device = kAudioObjectUnknown;
    UInt32 size = sizeof(device);
    AudioObjectPropertyAddress deviceAddress = { kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &deviceAddress, 0, NULL, &size, &device) != noErr || device == kAudioObjectUnknown) return nil;
    CFStringRef uid = NULL;
    size = sizeof(uid);
    AudioObjectPropertyAddress uidAddress = { kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    if (AudioObjectGetPropertyData(device, &uidAddress, 0, NULL, &size, &uid) != noErr || !uid) return nil;
    return [(__bridge NSString *)uid copy];
}

static BOOL read_tap_format(AudioObjectID tap, AudioStreamBasicDescription *format) {
    UInt32 size = sizeof(*format);
    AudioObjectPropertyAddress address = { kAudioTapPropertyFormat, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    return AudioObjectGetPropertyData(tap, &address, 0, NULL, &size, format) == noErr;
}

static int configure_unit(PssstCapture *capture, char *error, size_t errorLength) {
    AudioComponentDescription description = { kAudioUnitType_Output, kAudioUnitSubType_HALOutput, kAudioUnitManufacturer_Apple, 0, 0 };
    AudioComponent component = AudioComponentFindNext(NULL, &description);
    if (!component) { set_error(error, errorLength, "Audio output unit is unavailable"); return -1; }
    OSStatus status = AudioComponentInstanceNew(component, &capture->unit);
    if (status != noErr) { set_status_error(error, errorLength, "Could not create audio output unit", status); return -1; }
    UInt32 enabled = 1, disabled = 0;
    status = AudioUnitSetProperty(capture->unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &enabled, sizeof(enabled));
    if (status != noErr) { set_status_error(error, errorLength, "Could not enable audio input", status); return -1; }
    AudioUnitSetProperty(capture->unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &disabled, sizeof(disabled));
    status = AudioUnitSetProperty(capture->unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &capture->aggregate, sizeof(capture->aggregate));
    if (status != noErr) { set_status_error(error, errorLength, "Could not attach the audio tap device", status); return -1; }
    // Force a browser-friendly, interleaved stereo stream.
    AudioStreamBasicDescription format = {0};
    format.mSampleRate = 48000;
    format.mFormatID = kAudioFormatLinearPCM;
    format.mFormatFlags = kAudioFormatFlagsNativeFloatPacked;
    format.mBytesPerPacket = 8;
    format.mFramesPerPacket = 1;
    format.mBytesPerFrame = 8;
    format.mChannelsPerFrame = 2;
    format.mBitsPerChannel = 32;
    AudioUnitSetProperty(capture->unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &format, sizeof(format));
    AURenderCallbackStruct callback = { render_callback, capture };
    status = AudioUnitSetProperty(capture->unit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, &callback, sizeof(callback));
    if (status != noErr) { set_status_error(error, errorLength, "Could not install audio callback", status); return -1; }
    status = AudioUnitInitialize(capture->unit);
    if (status != noErr) { set_status_error(error, errorLength, "Could not initialize audio unit", status); return -1; }
    status = AudioOutputUnitStart(capture->unit);
    if (status != noErr) { set_status_error(error, errorLength, "Could not start audio unit", status); return -1; }
    return 0;
}

int pssst_audio_start(int pid, const char *path, uint64_t *handle, char *error, size_t errorLength) {
    if (!path || !handle) { set_error(error, errorLength, "Invalid audio capture arguments"); return -1; }
    @autoreleasepool {
        PssstCapture *capture = calloc(1, sizeof(PssstCapture));
        if (!capture) { set_error(error, errorLength, "Could not allocate audio capture"); return -1; }
        capture->file = fopen(path, "wb");
        if (!capture->file) { set_error(error, errorLength, strerror(errno)); free(capture); return -1; }
        capture->sourceFormat.mSampleRate = 48000;
        capture->sourceFormat.mChannelsPerFrame = 2;
        write_wav_header(capture->file, 0, 48000, 2);
        if (pid > 0) {
            NSArray<NSNumber *> *processObjects = process_objects_for_app((pid_t)pid);
            CATapDescription *description = nil;
            if (processObjects.count > 0) {
                description = [[CATapDescription alloc] initStereoMixdownOfProcesses:processObjects];
            } else {
                // If the app has not created any audio streams yet, capture all system output
                description = [[CATapDescription alloc] initStereoGlobalTapButExcludeProcesses:@[]];
            }
            description.UUID = [NSUUID UUID];
            description.privateTap = YES; description.name = @"Pssst application audio";
            OSStatus status = AudioHardwareCreateProcessTap(description, &capture->tap);
            if (status != noErr) { set_status_error(error, errorLength, "Could not create application audio tap", status); fclose(capture->file); free(capture); return -1; }
            NSString *outputUID = default_output_uid();
            if (!outputUID || !read_tap_format(capture->tap, &capture->sourceFormat)) { set_error(error, errorLength, "Could not read the active audio device format"); AudioHardwareDestroyProcessTap(capture->tap); fclose(capture->file); free(capture); return -1; }
            NSString *aggregateUID = [NSString stringWithFormat:@"com.irisla.pssst.tap.%d.%u", getpid(), arc4random()];
            NSDictionary *tapEntry = @{ @"uid": description.UUID.UUIDString, @"drift": @YES };
            NSDictionary *aggregateDescription = @{
                @"uid": aggregateUID, @"name": @"Pssst private audio tap", @"private": @YES, @"stacked": @NO,
                @"master": outputUID, @"subdevices": @[ @{ @"uid": outputUID } ],
                @"taps": @[tapEntry], @"tapautostart": @YES
            };
            status = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)aggregateDescription, &capture->aggregate);
            if (status != noErr) { set_status_error(error, errorLength, "Could not create private audio device", status); AudioHardwareDestroyProcessTap(capture->tap); fclose(capture->file); free(capture); return -1; }
            capture->processTap = YES;
        } else {
            AudioObjectPropertyAddress address = { kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
            UInt32 size = sizeof(capture->aggregate);
            OSStatus status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, &capture->aggregate);
            if (status != noErr || capture->aggregate == kAudioObjectUnknown) { set_status_error(error, errorLength, "Could not find the default microphone", status); fclose(capture->file); free(capture); return -1; }
        }
        if (capture->processTap) {
            dispatch_queue_t queue = dispatch_queue_create("com.irisla.pssst.audio-tap", DISPATCH_QUEUE_SERIAL);
            OSStatus status = AudioDeviceCreateIOProcIDWithBlock(&capture->ioProc, capture->aggregate, queue, ^(const AudioTimeStamp *inNow, const AudioBufferList *inInputData, const AudioTimeStamp *inInputTime, AudioBufferList *outOutputData, const AudioTimeStamp *inOutputTime) {
                (void)inNow; (void)inInputTime; (void)outOutputData; (void)inOutputTime;
                write_pcm_from_buffers(capture, inInputData);
            });
            if (status != noErr) { set_status_error(error, errorLength, "Could not create the audio tap callback", status); AudioHardwareDestroyAggregateDevice(capture->aggregate); AudioHardwareDestroyProcessTap(capture->tap); fclose(capture->file); free(capture); return -1; }
            status = AudioDeviceStart(capture->aggregate, capture->ioProc);
            if (status != noErr) { set_status_error(error, errorLength, "Could not start the audio tap", status); AudioDeviceDestroyIOProcID(capture->aggregate, capture->ioProc); AudioHardwareDestroyAggregateDevice(capture->aggregate); AudioHardwareDestroyProcessTap(capture->tap); fclose(capture->file); free(capture); return -1; }
            capture->usesDeviceIO = YES;
        } else if (configure_unit(capture, error, errorLength) != 0) {
            if (capture->unit) AudioComponentInstanceDispose(capture->unit);
            if (capture->aggregate && capture->processTap) AudioHardwareDestroyAggregateDevice(capture->aggregate);
            if (capture->tap) AudioHardwareDestroyProcessTap(capture->tap);
            fclose(capture->file); free(capture); return -1;
        }
        *handle = (uint64_t)(uintptr_t)capture;
        return 0;
    }
}

int pssst_audio_stop(uint64_t handle, char *error, size_t errorLength) {
    PssstCapture *capture = (PssstCapture *)(uintptr_t)handle;
    if (!capture) return 0;
    if (capture->usesDeviceIO && capture->aggregate && capture->ioProc) {
        AudioDeviceStop(capture->aggregate, capture->ioProc);
        AudioDeviceDestroyIOProcID(capture->aggregate, capture->ioProc);
    } else if (capture->unit) {
        AudioOutputUnitStop(capture->unit);
        AudioUnitUninitialize(capture->unit);
        AudioComponentInstanceDispose(capture->unit);
    }
    if (capture->file) { write_wav_header(capture->file, (uint32_t)(capture->bytes > UINT32_MAX ? UINT32_MAX : capture->bytes), (uint32_t)capture->sourceFormat.mSampleRate, (uint16_t)capture->sourceFormat.mChannelsPerFrame); fflush(capture->file); fclose(capture->file); }
    if (capture->aggregate && capture->processTap) AudioHardwareDestroyAggregateDevice(capture->aggregate);
    if (capture->tap) AudioHardwareDestroyProcessTap(capture->tap);
    free(capture); (void)error; (void)errorLength; return 0;
}

int pssst_audio_permission_probe(char *error, size_t errorLength) {
    AudioObjectPropertyAddress address = { kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    AudioDeviceID device = kAudioObjectUnknown; UInt32 size = sizeof(device);
    OSStatus status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, &device);
    if (status != noErr || device == kAudioObjectUnknown) { set_status_error(error, errorLength, "No audio device is available", status); return -1; }
    return 0;
}
