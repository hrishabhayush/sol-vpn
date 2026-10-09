use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha384, Sha512};

#[derive(Deserialize)]
struct AttestResp {
    tee: String,
    report: String,
    wg_pubkey: String,
    endpoint: String,
    node_id: u8,
}

#[derive(Serialize)]
pub struct Attested {
    pub tee: String,
    pub wg_pubkey: String,
    pub endpoint: String,
    pub node_id: u8,
    pub measurement: String,
    pub tcb_status: String,
}

type R<T> = Result<T, String>;

/// GET /attest with a fresh nonce; refuse unless the quote is genuine, bound to
/// (wg_pubkey || nonce), and carries the expected measurement (hex).
pub async fn verify(node_url: &str, expected_measurement: &str) -> R<Attested> {
    let nonce: [u8; 32] = rand::random();
    let url = format!("{}/attest?nonce={}", node_url.trim_end_matches('/'), hex::encode(nonce));
    let r: AttestResp = reqwest::get(&url)
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("node unreachable: {e}"))?
        .json()
        .await
        .map_err(|e| format!("bad /attest response: {e}"))?;
    let report = B64.decode(&r.report).map_err(|_| "report is not base64")?;
    let wg = B64.decode(&r.wg_pubkey).map_err(|_| "wg_pubkey is not base64")?;
    if wg.len() != 32 {
        return Err("wg_pubkey is not 32 bytes".into());
    }

    let (report_data, measurement, tcb_status) = match r.tee.as_str() {
        "tdx" => tdx(&report).await?,
        "sev-snp" => snp(&report).await?,
        "mock" if cfg!(debug_assertions) => mock(&report)?,
        "mock" => return Err("mock TEE refused in release builds".into()),
        t => return Err(format!("unknown tee type {t:?}")),
    };
    check_binding(&report_data, &wg, &nonce)?;
    let measurement = hex::encode(measurement);
    if r.tee != "mock" && !measurement.eq_ignore_ascii_case(expected_measurement.trim()) {
        return Err(format!("measurement mismatch: node runs {measurement}, registry expects {expected_measurement}"));
    }
    Ok(Attested { tee: r.tee, wg_pubkey: r.wg_pubkey, endpoint: r.endpoint, node_id: r.node_id, measurement, tcb_status })
}

fn check_binding(report_data: &[u8], wg: &[u8], nonce: &[u8]) -> R<()> {
    let want = Sha512::new().chain_update(wg).chain_update(nonce).finalize();
    if report_data != &want[..] {
        return Err("report_data mismatch: quote is not bound to this node's WireGuard key and our nonce".into());
    }
    Ok(())
}

/// Mock report (debug only): just the raw 64-byte report_data; no signature, no measurement.
fn mock(report: &[u8]) -> R<(Vec<u8>, Vec<u8>, String)> {
    if report.len() != 64 {
        return Err("mock report must be 64 bytes".into());
    }
    Ok((report.to_vec(), vec![], "mock".into()))
}

/// TDX: dcap-qvl fetches collateral (PCCS_URL env, default Phala PCCS) and checks the
/// Intel signature chain + TCB.
async fn tdx(quote: &[u8]) -> R<(Vec<u8>, Vec<u8>, String)> {
    use dcap_qvl::quote::Report;
    let v = dcap_qvl::collateral::CollateralClient::from_env()
        .map_err(|e| format!("PCCS client: {e:#}"))?
        .fetch_and_verify(quote)
        .await
        .map_err(|e| format!("TDX quote verification failed: {e:#}"))?;
    let td = match &v.report {
        Report::TD10(r) => r,
        Report::TD15(r) => &r.base,
        Report::SgxEnclave(_) => return Err("quote is SGX, not TDX".into()),
    };
    if td.td_attributes[0] & 1 != 0 {
        return Err("TDX guest is in DEBUG mode".into());
    }
    // protocol.md: SHA-384(MRTD || RTMR3); RTMR3 covers the node daemon code.
    let m = Sha384::new().chain_update(td.mr_td).chain_update(td.rt_mr3).finalize();
    Ok((td.report_data.to_vec(), m.to_vec(), v.status))
}

/// SEV-SNP: VCEK from AMD KDS, ARK/ASK built into the `sev` crate.
async fn snp(bytes: &[u8]) -> R<(Vec<u8>, Vec<u8>, String)> {
    use sev::Generation;
    use sev::certs::snp::{Certificate, Chain, Verifiable, builtin, ca};
    use sev::firmware::guest::AttestationReport;
    use sev::parser::ByteParser;

    let rep = AttestationReport::from_bytes(bytes).map_err(|e| format!("bad SNP report: {e}"))?;
    if rep.policy.debug_allowed() {
        return Err("SNP guest policy allows debugging".into());
    }
    let generation = match (rep.cpuid_fam_id, rep.cpuid_mod_id) {
        (Some(f), Some(m)) => Generation::identify_cpu(f, m).map_err(|e| e.to_string())?,
        _ => Generation::Milan, // ponytail: v2 reports lack CPUID; assume Milan, the common cloud SNP part
    };
    let (ark, ask) = match generation {
        Generation::Milan => (builtin::milan::ark(), builtin::milan::ask()),
        Generation::Genoa => (builtin::genoa::ark(), builtin::genoa::ask()),
        Generation::Turin => (builtin::turin::ark(), builtin::turin::ask()),
        g => return Err(format!("unsupported SNP generation {}", g.titlecase())),
    };
    let t = &rep.reported_tcb;
    let spl = format!("blSPL={}&teeSPL={}&snpSPL={}&ucodeSPL={}", t.bootloader, t.tee, t.snp, t.microcode);
    let url = match generation {
        Generation::Turin => format!(
            "https://kdsintf.amd.com/vcek/v1/Turin/{}?fmcSPL={}&{spl}",
            hex::encode(&rep.chip_id[..8]),
            t.fmc.unwrap_or(0)
        ),
        g => format!("https://kdsintf.amd.com/vcek/v1/{}/{}?{spl}", g.titlecase(), hex::encode(rep.chip_id)),
    };
    let der = reqwest::get(&url)
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("AMD KDS: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("AMD KDS: {e}"))?;
    let chain = Chain {
        ca: ca::Chain { ark: ark.map_err(|e| e.to_string())?, ask: ask.map_err(|e| e.to_string())? },
        vek: Certificate::from_der(&der).map_err(|e| format!("bad VCEK: {e}"))?,
    };
    (&chain, &rep).verify().map_err(|e| format!("SNP signature chain invalid: {e}"))?;
    Ok((rep.report_data.to_vec(), Sha384::digest(rep.measurement).to_vec(), "ok".into()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn binding() {
        use sha2::{Digest, Sha512};
        let (wg, nonce) = ([1u8; 32], [2u8; 32]);
        let mut cat = wg.to_vec();
        cat.extend(nonce);
        let rd = Sha512::digest(&cat);
        assert!(super::check_binding(&rd, &wg, &nonce).is_ok());
        assert!(super::check_binding(&rd, &wg, &[3u8; 32]).is_err());
    }
}

/// Needs `pnpm mock-node` (node/ in --mock mode) running: `cargo test -- --ignored`.
#[cfg(test)]
#[test]
#[ignore]
fn against_mock_node() {
    let url = "http://127.0.0.1:8443";
    let ok = tauri::async_runtime::block_on(verify(url, "")).unwrap();
    assert_eq!(ok.tee, "mock");
    let bad = tauri::async_runtime::block_on(verify("http://127.0.0.1:1", "")).err().unwrap();
    assert!(bad.contains("unreachable"), "{bad}");
}
