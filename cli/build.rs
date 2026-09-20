use std::{env, fs, path::PathBuf};

fn main() {
    let source =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest directory must be set"))
            .join("../shared/limits.json");
    println!("cargo:rerun-if-changed={}", source.display());
    let contents = fs::read_to_string(&source).expect("shared upload limits must be readable");
    let limits: serde_json::Value =
        serde_json::from_str(&contents).expect("shared upload limits must be valid JSON");
    let number = |key: &str| {
        limits[key]
            .as_u64()
            .unwrap_or_else(|| panic!("limit {key} must be an unsigned integer"))
    };
    let generated = format!(
        "pub const MAX_IMAGE_BYTES: u64 = {};\npub const MAX_AXIS: u32 = {};\npub const MAX_PIXELS: u64 = {};\npub const MAX_SCREENSHOTS: usize = {};\npub const MAX_RUN_BYTES: u64 = {};\npub const PAGE_ENTRIES: usize = {};\n",
        number("compressedImageBytes"),
        number("imageAxisPixels"),
        number("decodedImagePixels"),
        number("screenshotsPerRun"),
        number("logicalRunBytes"),
        number("manifestPageEntries"),
    );
    let output = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR must be set")).join("limits.rs");
    fs::write(output, generated).expect("generated upload limits must be writable");
}
