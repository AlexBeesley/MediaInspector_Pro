using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace MediaInspector {

// Owns the mpv process and keeps its video output parented inside a control
// we supply, so the picture and the controls share one window.
public class MpvPlayer {

    public const string PipeName = "mediainspector_pro";

    [DllImport("user32.dll")]
    private static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);

    private delegate bool EnumChildProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, EnumChildProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);

    [DllImport("user32.dll")]
    private static extern bool EnableWindow(IntPtr h, bool enable);
    [DllImport("user32.dll")]
    private static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll")]
    private static extern IntPtr SetFocus(IntPtr h);
    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr h);

    private Process _proc;
    private IntPtr _child = IntPtr.Zero;

    public string ExePath { get; private set; }
    public bool Alive { get { return _proc != null && !_proc.HasExited; } }

    public static string FindMpv() {
        string p = @"C:\Program Files\MPV Player\mpv.exe";
        if (File.Exists(p)) return p;
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in path.Split(';')) {
            if (dir.Length == 0) continue;
            try {
                string c = Path.Combine(dir.Trim(), "mpv.exe");
                if (File.Exists(c)) return c;
            } catch { }
        }
        return null;
    }

    // hostHandle is the control mpv should draw into. configDir carries the
    // project's mpv.conf, input.conf and the Lua script, so the on-video bar,
    // keybindings and GPU settings are all unchanged from the standalone player.
    public bool Start(IntPtr hostHandle, string configDir, string file) {
        ExePath = FindMpv();
        if (ExePath == null) return false;

        var args = new StringBuilder();
        args.Append("--config-dir=\"").Append(configDir).Append("\" ");
        args.Append("--wid=").Append(hostHandle.ToInt64()).Append(' ');
        args.Append("--input-ipc-server=\\\\.\\pipe\\").Append(PipeName).Append(' ');
        // The host owns window sizing now, so the script must not also try to
        // drive it - a child window cannot resize the frame around it.
        args.Append("--script-opts=mi-embedded=yes ");
        if (!string.IsNullOrEmpty(file)) args.Append('"').Append(file).Append('"');

        var si = new ProcessStartInfo(ExePath, args.ToString());
        si.UseShellExecute = false;
        si.CreateNoWindow = true;
        si.WorkingDirectory = configDir;
        _proc = Process.Start(si);
        return _proc != null;
    }

    // The picture is a window of mpv's own, living inside the host control.
    // Find it so we can size it and hand it input.
    private IntPtr FindChild(IntPtr hostHandle) {
        if (_child != IntPtr.Zero && IsWindow(_child)) return _child;
        _child = IntPtr.Zero;
        IntPtr found = IntPtr.Zero;
        EnumChildWindows(hostHandle, delegate (IntPtr h, IntPtr l) {
            var cls = new StringBuilder(64);
            GetClassNameW(h, cls, 64);
            if (cls.ToString() == "mpv") { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        _child = found;
        return found;
    }

    // mpv creates that child window with WS_DISABLED, on the assumption that
    // whoever embedded it wants to own input and will drive playback over the
    // IPC socket. Windows skips disabled windows when it decides where a
    // click lands, so every click on the picture fell through to the host
    // panel behind it: mpv's own on-video bar - play, the seek bar, the speed
    // shuttle, the buttons - could be seen but never pressed, and no key
    // binding in input.conf ever fired because the window could not take
    // focus either. Clearing the flag gives that whole UI back; the control
    // cards keep working because they are separate windows with their own
    // hit-testing. mpv re-applies the style on some state changes, so this is
    // re-asserted from the poll rather than done once at startup.
    private void EnableChildInput(IntPtr child) {
        if (child == IntPtr.Zero || IsWindowEnabled(child)) return;
        EnableWindow(child, true);
    }

    // mpv creates its own child window inside the host; when the host resizes,
    // that child has to be told to follow or the picture stays its old size.
    public void ResizeChildTo(IntPtr hostHandle, int width, int height) {
        if (width <= 0 || height <= 0) return;
        IntPtr child = FindChild(hostHandle);
        if (child == IntPtr.Zero) return;
        EnableChildInput(child);
        MoveWindow(child, 0, 0, width, height, true);
    }

    // Keyboard goes wherever focus is, and focus starts on the host's own
    // controls - so the player's key bindings would stay dead until the first
    // click on the picture. Put focus on the video up front instead, which is
    // where a player's keys belong. SetFocus only reaches windows on the
    // caller's input queue, and mpv is a separate process, so its thread has
    // to be attached for the length of the call.
    public void FocusVideo(IntPtr hostHandle) {
        IntPtr child = FindChild(hostHandle);
        if (child == IntPtr.Zero) return;
        EnableChildInput(child);

        uint pid;
        uint mpvThread = GetWindowThreadProcessId(child, out pid);
        uint self = GetCurrentThreadId();
        if (mpvThread == 0 || mpvThread == self) { SetFocus(child); return; }

        if (!AttachThreadInput(self, mpvThread, true)) return;
        try { SetFocus(child); }
        finally { AttachThreadInput(self, mpvThread, false); }
    }

    public void Quit(MpvIpc ipc) {
        try { if (ipc != null && ipc.Connected) ipc.Command("quit"); } catch { }
        try {
            if (_proc != null && !_proc.HasExited) {
                if (!_proc.WaitForExit(1500)) _proc.Kill();
            }
        } catch { }
    }

    // Hand a file to an instance that is already running, so "open with" from
    // Explorer reuses the window instead of starting a second player that
    // would fight over the same IPC pipe.
    public static bool HandOffToRunningInstance(string file) {
        try {
            var ipc = new MpvIpc(PipeName);
            if (!ipc.Connect(400)) return false;
            ipc.Command("loadfile", file, "replace");
            System.Threading.Thread.Sleep(150);
            ipc.Disconnect();
            return true;
        } catch { return false; }
    }
}
}
