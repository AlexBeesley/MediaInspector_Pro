using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Text;

namespace MediaInspector {

// Minimal JSON handling. mpv's IPC only ever hands us a small object per
// line, and the only field that matters is "data", so a full parser would be
// dead weight - but the extraction still has to respect strings, escapes and
// nesting or a filename containing a brace silently corrupts every later read.
public static class Json {

    public static string Escape(string s) {
        StringBuilder b = new StringBuilder(s.Length + 8);
        foreach (char c in s) {
            switch (c) {
                case '"':  b.Append("\\\""); break;
                case '\\': b.Append("\\\\"); break;
                case '\n': b.Append("\\n");  break;
                case '\r': b.Append("\\r");  break;
                case '\t': b.Append("\\t");  break;
                default:
                    if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
                    else b.Append(c);
                    break;
            }
        }
        return b.ToString();
    }

    public static string Unescape(string s) {
        StringBuilder b = new StringBuilder(s.Length);
        for (int i = 0; i < s.Length; i++) {
            if (s[i] != '\\') { b.Append(s[i]); continue; }
            i++;
            if (i >= s.Length) break;
            switch (s[i]) {
                case 'n': b.Append('\n'); break;
                case 'r': b.Append('\r'); break;
                case 't': b.Append('\t'); break;
                case 'b': b.Append('\b'); break;
                case 'f': b.Append('\f'); break;
                case 'u':
                    if (i + 4 < s.Length) {
                        int code;
                        if (int.TryParse(s.Substring(i + 1, 4), NumberStyles.HexNumber,
                                         CultureInfo.InvariantCulture, out code)) {
                            b.Append((char)code);
                        }
                        i += 4;
                    }
                    break;
                default: b.Append(s[i]); break;
            }
        }
        return b.ToString();
    }

    // Serialise one command argument. mpv accepts strings, numbers and bools.
    public static string Value(object o) {
        if (o == null) return "null";
        if (o is bool) return ((bool)o) ? "true" : "false";
        if (o is int || o is long) return Convert.ToString(o, CultureInfo.InvariantCulture);
        if (o is double || o is float || o is decimal) {
            return Convert.ToDouble(o, CultureInfo.InvariantCulture)
                          .ToString("R", CultureInfo.InvariantCulture);
        }
        return "\"" + Escape(Convert.ToString(o, CultureInfo.InvariantCulture)) + "\"";
    }

    // Pull the raw token that follows "data": - string contents are returned
    // already unescaped, everything else verbatim. Returns null when absent.
    public static string ExtractData(string line) {
        if (string.IsNullOrEmpty(line)) return null;
        int i = line.IndexOf("\"data\"", StringComparison.Ordinal);
        if (i < 0) return null;
        i = line.IndexOf(':', i + 6);
        if (i < 0) return null;
        i++;
        while (i < line.Length && char.IsWhiteSpace(line[i])) i++;
        if (i >= line.Length) return null;

        if (line[i] == '"') {
            StringBuilder b = new StringBuilder();
            i++;
            while (i < line.Length) {
                if (line[i] == '\\') {
                    if (i + 1 < line.Length) { b.Append(line[i]).Append(line[i + 1]); i += 2; continue; }
                    break;
                }
                if (line[i] == '"') break;
                b.Append(line[i]); i++;
            }
            return Unescape(b.ToString());
        }

        if (line[i] == '{' || line[i] == '[') {
            char open = line[i], close = (open == '{') ? '}' : ']';
            int depth = 0; bool inStr = false; int start = i;
            for (; i < line.Length; i++) {
                char c = line[i];
                if (inStr) {
                    if (c == '\\') { i++; continue; }
                    if (c == '"') inStr = false;
                    continue;
                }
                if (c == '"') { inStr = true; continue; }
                if (c == open) depth++;
                else if (c == close) { depth--; if (depth == 0) { i++; break; } }
            }
            return line.Substring(start, Math.Min(i, line.Length) - start);
        }

        int e = i;
        while (e < line.Length && line[e] != ',' && line[e] != '}') e++;
        return line.Substring(i, e - i).Trim();
    }
}

// Client for mpv's JSON IPC over a Windows named pipe.
public class MpvIpc {

    private NamedPipeClientStream _pipe;
    private StreamWriter _w;
    private StreamReader _r;
    private int _reqId;
    private readonly object _gate = new object();
    private readonly string _pipeName;

    public MpvIpc(string pipeName) { _pipeName = pipeName; }

    public bool Connected { get; private set; }

    public bool Connect(int timeoutMs) {
        lock (_gate) {
            if (Connected) return true;
            try {
                _pipe = new NamedPipeClientStream(".", _pipeName, PipeDirection.InOut);
                _pipe.Connect(timeoutMs);
                _w = new StreamWriter(_pipe) { AutoFlush = true };
                _r = new StreamReader(_pipe);
                Connected = true;
                // mpv interleaves async events with command replies on the same
                // pipe. Silencing them leaves a clean stream; the request_id
                // match below is still the actual guarantee.
                SendRaw("{\"command\":[\"disable_event\",\"all\"],\"request_id\":1}");
                return true;
            } catch {
                DisconnectLocked();
                return false;
            }
        }
    }

    public void Disconnect() { lock (_gate) { DisconnectLocked(); } }

    private void DisconnectLocked() {
        try { if (_w != null) _w.Dispose(); } catch { }
        try { if (_r != null) _r.Dispose(); } catch { }
        try { if (_pipe != null) _pipe.Dispose(); } catch { }
        _w = null; _r = null; _pipe = null;
        Connected = false;
    }

    private void SendRaw(string line) {
        _w.WriteLine(line);
    }

    // Returns the raw reply line carrying our request_id, or null.
    public string Command(params object[] cmd) {
        lock (_gate) {
            if (!Connected) return null;
            try {
                int id = ++_reqId + 1;
                StringBuilder b = new StringBuilder("{\"command\":[");
                for (int i = 0; i < cmd.Length; i++) {
                    if (i > 0) b.Append(',');
                    b.Append(Json.Value(cmd[i]));
                }
                b.Append("],\"request_id\":").Append(id).Append('}');
                SendRaw(b.ToString());

                // Discard anything that is not our reply. Without the id match
                // an interleaved line becomes the answer and every subsequent
                // read is off by one, silently pairing each property with the
                // wrong value.
                string want = "\"request_id\":" + id;
                for (int i = 0; i < 60; i++) {
                    string line = _r.ReadLine();
                    if (line == null) { DisconnectLocked(); return null; }
                    if (line.IndexOf(want, StringComparison.Ordinal) >= 0) return line;
                }
                return null;
            } catch {
                DisconnectLocked();
                return null;
            }
        }
    }

    public string GetString(string prop) {
        return Json.ExtractData(Command("get_property", prop));
    }

    public double? GetNumber(string prop) {
        string d = Json.ExtractData(Command("get_property", prop));
        double v;
        if (d != null && double.TryParse(d, NumberStyles.Float, CultureInfo.InvariantCulture, out v)) return v;
        return null;
    }

    public bool? GetBool(string prop) {
        string d = Json.ExtractData(Command("get_property", prop));
        if (d == "true") return true;
        if (d == "false") return false;
        return null;
    }

    public void Set(string prop, object value) { Command("set_property", prop, value); }

    // Raw user-data slot, for state the script reads directly.
    public void SetUserData(string name, string value) {
        Command("set_property", "user-data/mi/" + name, value);
    }

    // A *setting*. The Lua side reads these through its setting() helper,
    // which prefixes "set_" - writing the bare name lands on a property
    // nothing ever reads, and the setting silently does nothing.
    public void SetSetting(string name, string value) {
        Command("set_property", "user-data/mi/set_" + name, value);
    }

    public void ScriptBinding(string name) { Command("script-binding", name); }
}
}
