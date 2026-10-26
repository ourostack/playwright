# Samples the foreground window's process on Windows and prints one JSON object
# per line, like focus-sampler.swift does on macOS.
# Usage: focus-sampler-win.ps1 <interval-ms>
param([int]$IntervalMs = 50)
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DeskFocusWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
$names = @{}
function Now { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function Emit($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush() }
Emit @{ t = (Now); kind = 'start'; intervalMs = $IntervalMs; platform = 'windows' }
while ($true) {
  $hwnd = [DeskFocusWin]::GetForegroundWindow()
  [uint32]$frontPid = 0
  [void][DeskFocusWin]::GetWindowThreadProcessId($hwnd, [ref]$frontPid)
  $title = New-Object System.Text.StringBuilder 256
  [void][DeskFocusWin]::GetWindowText($hwnd, $title, 256)
  if (-not $names.ContainsKey($frontPid)) {
    try { $names[$frontPid] = (Get-Process -Id $frontPid -ErrorAction Stop).ProcessName } catch { $names[$frontPid] = '' }
  }
  Emit @{ t = (Now); kind = 'sample'; front = @{ pid = [int]$frontPid; name = $names[$frontPid] }; title = $title.ToString(); topWindowPid = [int]$frontPid }
  Start-Sleep -Milliseconds $IntervalMs
}
