fn main() {
    #[cfg(target_os = "macos")]
    {
        cc::Build::new()
            .file("native/core_audio_tap.m")
            .flag("-fobjc-arc")
            .flag("-mmacosx-version-min=14.2")
            .compile("pssst_core_audio_tap");
        println!("cargo:rustc-link-lib=framework=CoreAudio");
        println!("cargo:rustc-link-lib=framework=AudioToolbox");
        println!("cargo:rustc-link-lib=framework=Foundation");
    }
    tauri_build::build()
}
