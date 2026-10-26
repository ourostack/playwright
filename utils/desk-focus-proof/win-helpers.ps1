# Test-machine helpers for the Desk focus proof on Windows.
#   win-helpers.ps1 screenshot <file.png>   full virtual screen
#   win-helpers.ps1 front <pid>             bring that process's main window to the front
param([string]$Command, [string]$Arg)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DeskFocusHelpers {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
if ($Command -eq 'screenshot') {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $bmp.Save($Arg, [System.Drawing.Imaging.ImageFormat]::Png)
} elseif ($Command -eq 'front') {
  $p = Get-Process -Id ([int]$Arg)
  for ($i = 0; $i -lt 50 -and $p.MainWindowHandle -eq 0; $i++) { Start-Sleep -Milliseconds 100; $p.Refresh() }
  # Test-only: share input state with the current foreground thread so Windows
  # allows the switch. (Injecting an Alt key press would also work, but Alt
  # moves keyboard focus to the browser's menu button.)
  $fgThread = [DeskFocusHelpers]::GetWindowThreadProcessId([DeskFocusHelpers]::GetForegroundWindow(), [IntPtr]::Zero)
  $me = [DeskFocusHelpers]::GetCurrentThreadId()
  [void][DeskFocusHelpers]::AttachThreadInput($me, $fgThread, $true)
  [void][DeskFocusHelpers]::ShowWindow($p.MainWindowHandle, 9)
  [void][DeskFocusHelpers]::BringWindowToTop($p.MainWindowHandle)
  [void][DeskFocusHelpers]::SetForegroundWindow($p.MainWindowHandle)
  [void][DeskFocusHelpers]::AttachThreadInput($me, $fgThread, $false)
  if ([DeskFocusHelpers]::GetForegroundWindow() -ne $p.MainWindowHandle) {
    # Fallback: an injected Alt press lets this process switch the foreground; Escape then
    # takes keyboard focus back from the menu that Alt selects.
    [DeskFocusHelpers]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [DeskFocusHelpers]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [void][DeskFocusHelpers]::SetForegroundWindow($p.MainWindowHandle)
    Start-Sleep -Milliseconds 200
    [DeskFocusHelpers]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)
    [DeskFocusHelpers]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)
  }
  Write-Output ("foreground-is-target=" + ([DeskFocusHelpers]::GetForegroundWindow() -eq $p.MainWindowHandle))
}
