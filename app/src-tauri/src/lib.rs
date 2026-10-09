mod attest;

use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_positioner::{Position, WindowExt};

// Devnet USDC. ponytail: hardcoded devnet; make it configurable when we go to mainnet.
const USDC_MINT: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const IFACE: &str = "solvpn"; // wg-quick on macOS needs the conf file named <iface>.conf

type R<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Read a secret from the macOS Keychain (service "sol-vpn"), creating it with `init` if missing.
fn keychain(name: &str, init: impl FnOnce() -> Vec<u8>) -> R<Vec<u8>> {
    let entry = keyring::Entry::new("sol-vpn", name).map_err(err)?;
    match entry.get_secret() {
        Ok(s) => Ok(s),
        Err(keyring::Error::NoEntry) => {
            let s = init();
            entry.set_secret(&s).map_err(err)?;
            Ok(s)
        }
        Err(e) => Err(err(e)),
    }
}

/// App wallet as a Solana 64-byte keypair (secret || pubkey).
fn wallet_pubkey() -> R<String> {
    let kp = keychain("wallet", || {
        ed25519_dalek::SigningKey::from_bytes(&rand::random()).to_keypair_bytes().to_vec()
    })?;
    Ok(bs58::encode(&kp[32..]).into_string())
}

#[tauri::command]
async fn verify_attestation(node_url: String, expected_measurement: String) -> R<attest::Attested> {
    attest::verify(&node_url, &expected_measurement).await
}

#[tauri::command]
fn wallet_address() -> R<String> {
    wallet_pubkey()
}

/// Ledger slot secret (hex), handed to the TS ledger client for Arcium encryption.
#[tauri::command]
fn slot_secret() -> R<String> {
    keychain("slot-secret", || rand::random::<[u8; 32]>().to_vec()).map(hex::encode)
}

#[derive(Serialize)]
struct TopUp {
    url: String,
    svg: String,
}

/// Solana Pay transfer request funding the app wallet with USDC.
#[tauri::command]
fn topup(amount_usdc: String) -> R<TopUp> {
    let reference = bs58::encode(rand::random::<[u8; 32]>()).into_string();
    let url = solana_pay_url(&wallet_pubkey()?, &amount_usdc, &reference)?;
    let svg = qrcode::QrCode::new(&url)
        .map_err(err)?
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(200, 200)
        .build();
    Ok(TopUp { url, svg })
}

fn solana_pay_url(recipient: &str, amount: &str, reference: &str) -> R<String> {
    // Spec: decimal "user" units, leading zero required, no exponent; USDC has 6 decimals.
    let (int, frac) = amount.split_once('.').unwrap_or((amount, "0"));
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(int) || !digits(frac) || frac.len() > 6 {
        return Err(format!("invalid amount {amount:?}"));
    }
    Ok(format!(
        "solana:{recipient}?amount={amount}&spl-token={USDC_MINT}&reference={reference}&label=sol-vpn&message=Top%20up%20VPN%20minutes"
    ))
}

#[derive(Deserialize, Serialize)]
struct Session {
    session_id: String,
    client_ip: String,
    dns: String,
    expires_at: u64,
}

fn wg_config(private_key: &str, s: &Session, server_pubkey: &str, endpoint: &str) -> String {
    format!(
        "[Interface]\nPrivateKey = {private_key}\nAddress = {}\nDNS = {}\n\n[Peer]\nPublicKey = {server_pubkey}\nEndpoint = {endpoint}\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25\n",
        s.client_ip, s.dns
    )
}

fn conf_path(app: &AppHandle) -> R<PathBuf> {
    let dir = app.path().app_data_dir().map_err(err)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join(format!("{IFACE}.conf")))
}

/// Runs `wg-quick <up|down> <conf>` as root via the macOS admin prompt.
/// SOLVPN_DRY_RUN=1 skips it (config is still written) for testing without a tunnel.
fn wg_quick(action: &str, conf: &std::path::Path) -> R<()> {
    if std::env::var_os("SOLVPN_DRY_RUN").is_some() {
        eprintln!("[dry-run] wg-quick {action} {}", conf.display());
        return Ok(());
    }
    let cmd = format!("PATH=/opt/homebrew/bin:/usr/local/bin:$PATH wg-quick {action} '{}'", conf.display());
    let script = format!(
        "do shell script \"{}\" with administrator privileges",
        cmd.replace('\\', "\\\\").replace('"', "\\\"")
    );
    let out = std::process::Command::new("osascript").args(["-e", &script]).output().map_err(err)?;
    if !out.status.success() {
        return Err(format!("wg-quick {action} failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(())
}

async fn open_session(node_url: &str, client_wg_pubkey: &str, reserve_tx: &str) -> R<Session> {
    reqwest::Client::new()
        .post(format!("{}/session", node_url.trim_end_matches('/')))
        .json(&serde_json::json!({ "client_wg_pubkey": client_wg_pubkey, "reserve_tx": reserve_tx }))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("POST /session: {e}"))?
        .json()
        .await
        .map_err(|e| format!("bad /session response: {e}"))
}

#[tauri::command]
async fn connect(app: AppHandle, node_url: String, server_pubkey: String, endpoint: String, reserve_tx: String) -> R<Session> {
    let secret = x25519_dalek::StaticSecret::from(rand::random::<[u8; 32]>());
    let public = x25519_dalek::PublicKey::from(&secret);
    let private_key = B64.encode(secret.to_bytes());
    keyring::Entry::new("sol-vpn", "wg-private-key")
        .and_then(|e| e.set_password(&private_key))
        .map_err(err)?;

    let s = open_session(&node_url, &B64.encode(public.as_bytes()), &reserve_tx).await?;

    let conf = conf_path(&app)?;
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let _ = std::fs::remove_file(&conf);
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&conf)
            .map_err(err)?;
        f.write_all(wg_config(&private_key, &s, &server_pubkey, &endpoint).as_bytes())
            .map_err(err)?;
    }
    wg_quick("up", &conf)?;
    Ok(s)
}

#[tauri::command]
fn disconnect(app: AppHandle) -> R<()> {
    let conf = conf_path(&app)?;
    if conf.exists() {
        wg_quick("down", &conf)?;
        std::fs::remove_file(&conf).map_err(err)?;
    }
    Ok(())
}

#[derive(Deserialize)]
struct VoucherResp {
    expires_at: u64,
}

#[tauri::command]
async fn send_voucher(node_url: String, session_id: String, voucher: String, minutes: u64, counter: u64) -> R<u64> {
    let r: VoucherResp = reqwest::Client::new()
        .post(format!("{}/session/{session_id}/voucher", node_url.trim_end_matches('/')))
        .json(&serde_json::json!({ "voucher": voucher, "minutes": minutes, "counter": counter }))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("POST voucher: {e}"))?
        .json()
        .await
        .map_err(err)?;
    Ok(r.expires_at)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_positioner::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("sol-vpn")
                .on_tray_icon_event(|tray, event| {
                    tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        let Some(w) = tray.app_handle().get_webview_window("main") else { return };
                        if w.is_visible().unwrap_or(false) {
                            let _ = w.hide();
                        } else {
                            let _ = w.move_window(Position::TrayCenter);
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|w, e| {
            if let WindowEvent::Focused(false) = e {
                let _ = w.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            verify_attestation,
            wallet_address,
            slot_secret,
            topup,
            connect,
            disconnect,
            send_voucher
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_and_pay_url() {
        let s = Session { session_id: "ab".into(), client_ip: "10.8.0.2/32".into(), dns: "10.8.0.1".into(), expires_at: 0 };
        let c = wg_config("PRIV", &s, "SRV", "1.2.3.4:51820");
        assert!(c.contains("Address = 10.8.0.2/32\nDNS = 10.8.0.1\n"));
        assert!(c.contains("AllowedIPs = 0.0.0.0/0, ::/0"));
        assert!(c.contains("Endpoint = 1.2.3.4:51820"));

        let u = solana_pay_url("Rcpt", "0.5", "Ref").unwrap();
        assert_eq!(u, format!("solana:Rcpt?amount=0.5&spl-token={USDC_MINT}&reference=Ref&label=sol-vpn&message=Top%20up%20VPN%20minutes"));
        for bad in ["", ".5", "1.", "1e3", "-1", "0.1234567"] {
            assert!(solana_pay_url("R", bad, "Ref").is_err(), "{bad}");
        }
    }

    /// Needs node/ in --mock mode on :8443 (`pnpm mock-node`): `cargo test -- --ignored`.
    /// Full flow minus the tunnel: attest -> session -> wg config -> vouchers.
    #[test]
    #[ignore]
    fn against_mock_node() {
        tauri::async_runtime::block_on(async {
            let url = "http://127.0.0.1:8443";
            let att = attest::verify(url, "").await.unwrap();
            let key = x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(rand::random::<[u8; 32]>()));
            let s = open_session(url, &B64.encode(key.as_bytes()), &bs58::encode([rand::random::<[u8; 32]>(), rand::random()].concat()).into_string()).await.unwrap();
            assert_eq!(s.dns, "10.8.0.1");

            print!("{}", wg_config(&B64.encode([7u8; 32]), &s, &att.wg_pubkey, &att.endpoint));

            let v = |m: u64, c: u64| send_voucher(url.into(), s.session_id.clone(), "dm91Y2hlcg==".into(), m, c);
            assert!(v(1, 1).await.is_ok());
            assert!(v(1, 1).await.unwrap_err().contains("409"), "stale counter");
            assert!(v(1, 2).await.is_ok());
            assert!(send_voucher(url.into(), "nope".into(), "x".into(), 1, 1).await.unwrap_err().contains("404"));
        });
    }
}
