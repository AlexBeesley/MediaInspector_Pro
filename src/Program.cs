using System;
using System.IO;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace MediaInspector {

public static class Program {

    [STAThread]
    public static void Main(string[] args) {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string file = null;
        foreach (string a in args) {
            if (!string.IsNullOrEmpty(a) && a[0] != '-') { file = a; break; }
        }

        // Opening a file while a window is already up should reuse it rather
        // than start a second player - two would fight over the same IPC pipe.
        if (file != null && File.Exists(file)) {
            try { file = Path.GetFullPath(file); } catch { }
            if (MpvPlayer.HandOffToRunningInstance(file)) return;
        }

        // With no file given, resume whatever was open last. The Lua script
        // keeps that in state_player.json.
        if (file == null) file = LastFile(root);

        // Build the window, report the real geometry of every card and exit.
        // Layout faults in a card grid are invisible in code review and
        // obvious in numbers, so this stays in as the way to check it.
        foreach (string a in args) {
            if (a == "--dump-layout") { DumpLayout(root); return; }
        }

        try {
            Application.Run(new MainForm(root, file));
        } catch (Exception ex) {
            // Write it down as well as showing it: a dialog is useless the
            // moment the app is launched by Explorer and nobody is watching.
            try {
                File.WriteAllText(Path.Combine(root, "state_error.log"),
                    DateTime.Now.ToString("u") + "\r\n" + ex);
            } catch { }
            MessageBox.Show(ex.ToString(), "MediaInspector_Pro");
        }
    }

    private static void DumpLayout(string root) {
        var sb = new System.Text.StringBuilder();
        using (var f = new MainForm(root, null)) {
            f.CreateControl();
            foreach (int w in new[] { 1200, 1600, 2200, 2800 }) {
                f.Size = new System.Drawing.Size(w, 1100);
                f.PerformLayout();
                Application.DoEvents();
                f.PerformLayout();

                var grid = f.CardGrid;
                var xs = new System.Collections.Generic.List<int>();
                int clipped = 0, maxRight = 0;
                foreach (Control card in grid.Controls) {
                    if (!xs.Contains(card.Left)) xs.Add(card.Left);
                    if (card.Right > maxRight) maxRight = card.Right;
                    // A card is clipped when its content flow needs more room
                    // than the card gives it.
                    foreach (Control kid in card.Controls) {
                        if (kid is FlowLayoutPanel) {
                            int need = kid.Top + kid.Height + card.Padding.Bottom;
                            if (need > card.Height + 1) clipped++;
                        }
                    }
                }
                sb.AppendLine("window " + w + " -> grid " + grid.ClientSize.Width +
                              "  cards=" + grid.Controls.Count +
                              "  columns=" + xs.Count +
                              "  clipped=" + clipped +
                              "  rightmost=" + maxRight);

                // And again with the splitter dragged out, which is how the
                // grid is meant to gain columns.
                var split = grid.Parent.Parent as SplitContainer;
                if (split != null) {
                    try {
                        // Drag it out to where a second card column becomes
                        // possible, which is the behaviour being checked.
                        split.SplitterDistance = Math.Max(split.Panel1MinSize,
                            Math.Min(w - split.Panel2MinSize - split.SplitterWidth, 2 * (MainForm.CardW + 10) + 30));
                        f.PerformLayout();
                        Application.DoEvents();
                        f.PerformLayout();
                        var xs2 = new System.Collections.Generic.List<int>();
                        int clipped2 = 0;
                        foreach (Control card in grid.Controls) {
                            if (!xs2.Contains(card.Left)) xs2.Add(card.Left);
                            foreach (Control kid in card.Controls) {
                                if (kid is FlowLayoutPanel &&
                                    kid.Top + kid.Height + card.Padding.Bottom > card.Height + 1) clipped2++;
                            }
                        }
                        sb.AppendLine("            splitter dragged -> grid " + grid.ClientSize.Width +
                                      "  columns=" + xs2.Count + "  clipped=" + clipped2);
                        split.SplitterDistance = MainForm.CardW + 34;
                    } catch { }
                }
                if (w == 1600) {
                    foreach (Control card in grid.Controls) {
                        string title = "?";
                        foreach (Control kid in card.Controls) {
                            if (kid is Panel && !(kid is FlowLayoutPanel) && kid.Controls.Count > 0)
                                title = kid.Controls[0].Text;
                        }
                        sb.AppendLine("    " + title.PadRight(32) + " " + card.Bounds);
                    }
                }
            }
        }
        File.WriteAllText(Path.Combine(root, "state_layout.txt"), sb.ToString());
        Console.Write(sb.ToString());
    }

    private static string LastFile(string root) {
        try {
            string p = Path.Combine(root, "state_player.json");
            if (!File.Exists(p)) return null;
            string raw = File.ReadAllText(p);
            Match m = Regex.Match(raw, "\"file\"\\s*:\\s*\"(.*?)(?<!\\\\)\"");
            if (!m.Success) return null;
            string f = Json.Unescape(m.Groups[1].Value);
            return File.Exists(f) ? f : null;
        } catch { return null; }
    }
}
}

