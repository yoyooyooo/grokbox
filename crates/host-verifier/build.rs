fn main() {
    println!("cargo:rerun-if-env-changed=GROKBOX_VERIFIER_BUILD_ID");
    let id=std::env::var("GROKBOX_VERIFIER_BUILD_ID").unwrap_or_else(|_|"0".repeat(64));
    assert!(id.len()==64 && id.bytes().all(|b|b.is_ascii_hexdigit()),"invalid_build_identity");
    println!("cargo:rustc-env=GROKBOX_VERIFIER_BUILD_ID={id}");
}
