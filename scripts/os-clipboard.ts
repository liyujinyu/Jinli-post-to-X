/**
 * os-clipboard.ts — Stable layer, OS-level operations core.
 *
 * Implements the verified rule: CDP synthetic key events do NOT read the system
 * clipboard and DraftJS does not respond to them. Real paste / delete must go
 * through the OS via PowerShell SendKeys, with the target window brought to the
 * foreground first (Page.bringToFront from cdp.ts + WScript.Shell.AppActivate
 * here). See references/troubleshooting.md "铁律".
 *
 * Windows is fully implemented (the platform this was verified on). macOS and
 * Linux are stubbed with clear errors — TODO until verified on those platforms.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

export type WindowTarget = string;

/**
 * Substring of the automation Chrome's command line (its --user-data-dir) used
 * to pick the EXACT window to foreground before SendKeys. Title-based
 * AppActivate('Google Chrome') is ambiguous when the user's own Chrome is also
 * open — SendKeys then goes to the wrong window and the editor gets no image.
 * Matching the profile dir in the command line uniquely identifies our window.
 */
export const DEFAULT_PROFILE_MARKER = 'x-browser-profile';

/** Run a PowerShell command (STA mode, no profile) and await completion. */
function runPowerShell(script: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Sta', '-Command', script],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`PowerShell timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`PowerShell exited ${code}: ${stderr.trim()}`));
    });
  });
}

/** Escape a Windows path for single-quoted PowerShell string literal. */
function escPath(p: string): string {
  // Normalize backslashes are fine inside PS single-quotes; only ' must double.
  return p.replace(/'/g, "''");
}

// ---------------------------------------------------------------------------
// Windows implementation (verified)
// ---------------------------------------------------------------------------

async function copyImageWindows(imagePath: string): Promise<void> {
  const p = escPath(imagePath);
  // -Sta is mandatory: Clipboard.SetImage requires a single-threaded apartment.
  // Statements are newline-separated so PowerShell parses them reliably.
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    `$img = [System.Drawing.Image]::FromFile('${p}')`,
    '[System.Windows.Forms.Clipboard]::SetImage($img)',
    '$img.Dispose()',
  ].join('\n');
  await runPowerShell(script);
}

/**
 * The robust image-paste primitive: load the image onto the clipboard, activate
 * the automation Chrome window, and send Ctrl+V — all in ONE PowerShell STA
 * process. Doing it in one process eliminates the focus gap between a separate
 * "copy" and "paste" process (that gap is where Windows' foreground-lock used
 * to refuse SetForegroundWindow and lose the paste). Activation retries with
 * AttachThreadInput and falls back to AppActivate.
 */
export async function pasteImage(
  imagePath: string,
  profileMarker: WindowTarget = DEFAULT_PROFILE_MARKER,
  deleteFirst = false,
): Promise<void> {
  if (process.platform !== 'win32') {
    await copyImage(imagePath);
    await paste(profileMarker);
    return;
  }
  const p = escPath(imagePath);
  const marker = escPath(profileMarker);
  const del = deleteFirst ? "$w.SendKeys('{DELETE}'); Start-Sleep -Milliseconds 120" : '';
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    `$code = @'`,
    '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);',
    '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);',
    '[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
    `'@`,
    `Add-Type -MemberDefinition $code -Name Win -Namespace W`,
    `$w=New-Object -ComObject WScript.Shell`,
    // 1. activate FIRST (so the {DELETE} keystroke below reaches the composer)
    `$marker='${marker}'`,
    `$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$marker*" }`,
    `$hwnd=[IntPtr]::Zero`,
    `foreach($pi in $procs){ try{$pr=Get-Process -Id $pi.ProcessId}catch{$pr=$null}; if($pr -and $pr.MainWindowHandle -ne [IntPtr]::Zero){ $hwnd=$pr.MainWindowHandle; break } }`,
    `if($hwnd -eq [IntPtr]::Zero){ throw "No Chrome window matching marker $marker" }`,
    `$me=[W.Win]::GetCurrentThreadId()`,
    `$ok=$false`,
    `for($try=0; $try -lt 4 -and -not $ok; $try++){`,
    `  $fg=[W.Win]::GetForegroundWindow(); $fgt=[W.Win]::GetWindowThreadProcessId($fg,[ref]([uint32]0))`,
    `  if($fgt -ne $me){ [W.Win]::AttachThreadInput($me,$fgt,$true) | Out-Null }`,
    `  [W.Win]::ShowWindow($hwnd,9) | Out-Null`,
    `  $ok=[W.Win]::SetForegroundWindow($hwnd)`,
    `  if($fgt -ne $me){ [W.Win]::AttachThreadInput($me,$fgt,$false) | Out-Null }`,
    `  if(-not $ok){ Start-Sleep -Milliseconds 150; $ok = $w.AppActivate('Google Chrome') }`,
    `}`,
    `if(-not $ok){ throw "Could not activate Chrome window (marker=$marker)" }`,
    `Start-Sleep -Milliseconds 200`,
    // 2. (optional) delete the currently-selected token text — atomically, in the
    //    same process, BEFORE the paste. No inter-step focus gap, no leftover.
    del,
    // 3. load image to clipboard
    `$img = [System.Drawing.Image]::FromFile('${p}')`,
    '[System.Windows.Forms.Clipboard]::SetImage($img)',
    '$img.Dispose()',
    `Start-Sleep -Milliseconds 200`,
    // 4. paste
    `$w.SendKeys('^v')`,
    'Start-Sleep -Milliseconds 150',
  ].join('\n');
  await runPowerShell(script);
}


/**
 * Activate the automation Chrome (matched by profile dir in its command line)
 * and send a keystroke. Uses the AttachThreadInput trick to reliably take the
 * OS foreground — plain SetForegroundWindow/AppActivate silently fail when the
 * target isn't already foreground (Windows foreground-locking), which sends
 * SendKeys to the wrong window and loses every paste. AttachThreadInput onto
 * the current foreground thread makes SetForegroundWindow stick.
 */
async function activateAndSendKeysWindows(
  profileMarker: WindowTarget,
  keys: string,
): Promise<void> {
  const marker = escPath(profileMarker);
  const k = keys.replace(/'/g, "''");
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    `$code = @'`,
    '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);',
    '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);',
    '[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
    `'@`,
    `Add-Type -MemberDefinition $code -Name Win -Namespace W`,
    `$marker='${marker}'`,
    `$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$marker*" }`,
    `$hwnd=[IntPtr]::Zero`,
    `foreach($pi in $procs){ try{$pr=Get-Process -Id $pi.ProcessId}catch{$pr=$null}; if($pr -and $pr.MainWindowHandle -ne [IntPtr]::Zero){ $hwnd=$pr.MainWindowHandle; break } }`,
    `if($hwnd -eq [IntPtr]::Zero){ throw "No Chrome window matching marker $marker" }`,
    // Reliable foreground via AttachThreadInput (bypasses Windows foreground lock).
    `$me=[W.Win]::GetCurrentThreadId()`,
    `$fg=[W.Win]::GetForegroundWindow()`,
    `$fgt=[W.Win]::GetWindowThreadProcessId($fg, [ref]([uint32]0))`,
    `if($fgt -ne $me){ [W.Win]::AttachThreadInput($me,$fgt,$true) | Out-Null }`,
    `[W.Win]::ShowWindow($hwnd,9) | Out-Null`,
    `$ok=[W.Win]::SetForegroundWindow($hwnd)`,
    `if($fgt -ne $me){ [W.Win]::AttachThreadInput($me,$fgt,$false) | Out-Null }`,
    `Start-Sleep -Milliseconds 250`,
    `if(-not $ok){ throw "SetForegroundWindow failed (marker=$marker)" }`,
    `$w=New-Object -ComObject WScript.Shell`,
    `$w.SendKeys('${k}')`,
    'Start-Sleep -Milliseconds 150',
  ].join('\n');
  await runPowerShell(script);
}

// ---------------------------------------------------------------------------
// Public API (platform-dispatched)
// ---------------------------------------------------------------------------

/**
 * Write an image file to the system clipboard.
 * @param imagePath absolute path to a PNG/JPG/etc.
 */
export async function copyImage(imagePath: string): Promise<void> {
  if (process.platform === 'win32') return copyImageWindows(imagePath);
  // TODO(macOS): `osascript -e 'set the clipboard to (read POSIX file "…" as
  //   {«class PNGf»})'` — unverified, implement when needed.
  // TODO(linux): wl-copy / xclip — unverified.
  throw new Error(
    `copyImage not yet implemented for platform ${process.platform}`,
  );
}

/**
 * Activate the automation Chrome and send a real Ctrl+V (paste). Must be called
 * AFTER Page.bringToFront so the right tab is active within the window.
 */
export async function paste(profileMarker: WindowTarget = DEFAULT_PROFILE_MARKER): Promise<void> {
  if (process.platform === 'win32') {
    return activateAndSendKeysWindows(profileMarker, '^v');
  }
  throw new Error(`paste not yet implemented for platform ${process.platform}`);
}

/**
 * Activate the automation Chrome and send arbitrary SendKeys keystrokes
 * (e.g. '{BS}' backspace, '^v', '{DELETE}'). The selection/caret must be placed
 * via Selection API first — SendKeys goes to whatever the editor holds.
 */
export async function sendKeys(
  keys: string,
  profileMarker: WindowTarget = DEFAULT_PROFILE_MARKER,
): Promise<void> {
  if (process.platform === 'win32') {
    return activateAndSendKeysWindows(profileMarker, keys);
  }
  throw new Error(`sendKeys not yet implemented for platform ${process.platform}`);
}

/**
 * Activate the automation Chrome and press DELETE `times` times. Used to remove
 * a selected image — the selection must be created first via Selection API
 * (range.selectNode) in the page. CDP Backspace / execCommand('delete') do not
 * work on these DraftJS image figures.
 */
export async function deleteSelection(
  times = 3,
  profileMarker: WindowTarget = DEFAULT_PROFILE_MARKER,
): Promise<void> {
  if (process.platform === 'win32') {
    const keys = '{DELETE}'.repeat(times);
    return activateAndSendKeysWindows(profileMarker, keys);
  }
  throw new Error(
    `deleteSelection not yet implemented for platform ${process.platform}`,
  );
}

/** Activate the automation Chrome window (focus only, no keystroke). */
export async function activateWindow(
  profileMarker: WindowTarget = DEFAULT_PROFILE_MARKER,
): Promise<void> {
  // Reuse the same activation by sending a no-op key would alter state; instead
  // we activate with a harmless key press is NOT desired, so replicate activation
  // only. Cheapest: call activateAndSendKeys with an empty-ish action is messy,
  // so just focus via the same path sending nothing is impossible — expose focus
  // by sending nothing through a dedicated minimal script.
  if (process.platform === 'win32') {
    const marker = escPath(profileMarker);
    await runPowerShell([
      'Add-Type -AssemblyName System.Windows.Forms',
      `$code = @'`,
      '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
      '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);',
      `'@`,
      `Add-Type -MemberDefinition $code -Name Win -Namespace W`,
      `$marker='${marker}'`,
      `$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$marker*" }`,
      `foreach ($pi in $procs) { try { $pr=Get-Process -Id $pi.ProcessId } catch { $pr=$null }; if ($pr -and $pr.MainWindowHandle -ne [IntPtr]::Zero) { [W.Win]::ShowWindow($pr.MainWindowHandle,9)|Out-Null; [W.Win]::SetForegroundWindow($pr.MainWindowHandle)|Out-Null; break } }`,
    ].join('\n'));
    return;
  }
  throw new Error(
    `activateWindow not yet implemented for platform ${process.platform}`,
  );
}
