// PDFRev_Tauri 截图辅助：把窗口内容抓成位图。
// 用 PrintWindow + PW_RENDERFULLCONTENT(2)：WebView2 是 DirectComposition
// 渲染的，普通的 BitBlt 抓不到内容，会得到一片空白。
using System;
using System.Drawing;
using System.Runtime.InteropServices;

public class WinShot
{
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);

    // 让本进程变成 DPI 感知（Win10 1703+ 用 PerMonitorV2 的 fallback）。
    //
    // 不做这一步的话：PowerShell 是 DPI-unaware，Windows 会把窗口坐标虚拟化成
    // 逻辑像素。GetWindowRect 于是返回一整套缩小的整数（如 2404x1639 -> 1374x937），
    // 而 PrintWindow 往这个缩小的位图上贴真实像素，结果只贴进窗口内容的一角，
    // 截出来的图看起来「卡片跑到了右半边」——全是伪影，不是界面真的错位。
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    public static void MakeDpiAware()
    {
        try { SetProcessDPIAware(); } catch { }
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    /// 返回 (Bitmap, 宽度, 高度)；失败抛异常。
    public static Bitmap Capture(IntPtr hWnd)
    {
        ShowWindow(hWnd, 5);   // SW_SHOW
        SetForegroundWindow(hWnd);
        RECT r;
        if (!GetWindowRect(hWnd, out r)) throw new Exception("GetWindowRect 失败");
        int w = r.Right - r.Left, h = r.Bottom - r.Top;
        if (w <= 0 || h <= 0) throw new Exception("窗口尺寸异常: " + w + "x" + h);
        var bmp = new Bitmap(w, h);
        using (var g = Graphics.FromImage(bmp))
        {
            IntPtr hdc = g.GetHdc();
            try { PrintWindow(hWnd, hdc, 2); }   // 2 = PW_RENDERFULLCONTENT
            finally { g.ReleaseHdc(hdc); }
        }
        return bmp;
    }
}

