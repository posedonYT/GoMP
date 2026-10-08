# Draws the app icons of the GoMP phone (client/game/phone.cpp): white glyphs
# on transparent 128x128 PNGs. The phone puts them on coloured squares.
#
#   powershell -ExecutionPolicy Bypass -File tools/icons/phone-icons.ps1 client-dist/gomp/icons
param([string]$out = "client-dist/gomp/icons")

Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force $out | Out-Null

function New-Icon([string]$name, [scriptblock]$draw) {
    $bmp = New-Object System.Drawing.Bitmap 128, 128
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $clear = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Transparent)
    & $draw $g $white $clear
    $bmp.Save((Join-Path $out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}

# Cuts a shape out of what is drawn (transparent pixels).
function Clear-Shape($g, [scriptblock]$draw) {
    $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    & $draw
    $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
}

function RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddArc($x, $y, 2 * $r, 2 * $r, 180, 90)
    $p.AddArc($x + $w - 2 * $r, $y, 2 * $r, 2 * $r, 270, 90)
    $p.AddArc($x + $w - 2 * $r, $y + $h - 2 * $r, 2 * $r, 2 * $r, 0, 90)
    $p.AddArc($x, $y + $h - 2 * $r, 2 * $r, 2 * $r, 90, 90)
    $p.CloseFigure()
    return $p
}

function Pt([float]$x, [float]$y) { New-Object System.Drawing.PointF $x, $y }

New-Icon "app_contacts" {
    param($g, $white, $clear)
    $g.FillEllipse($white, 42, 14, 44, 44)
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddArc(20, 66, 88, 92, 180, 180)
    $p.CloseFigure()
    $g.SetClip((New-Object System.Drawing.RectangleF 0, 0, 128, 114))
    $g.FillPath($white, $p)
    $g.ResetClip()
}

New-Icon "app_messages" {
    param($g, $white, $clear)
    $g.FillPath($white, (RoundRect 12 18 104 74 26))
    $g.FillPolygon($white, [System.Drawing.PointF[]]@((Pt 30 80), (Pt 22 112), (Pt 60 88)))
    Clear-Shape $g { foreach ($x in 38, 64, 90) { $g.FillEllipse($clear, $x - 8, 47, 16, 16) } }
}

New-Icon "app_bank" {
    param($g, $white, $clear)
    $g.FillPolygon($white, [System.Drawing.PointF[]]@((Pt 64 10), (Pt 12 42), (Pt 116 42)))
    $g.FillRectangle($white, 16, 46, 96, 8)
    foreach ($x in 22, 46, 70, 94) { $g.FillRectangle($white, $x, 60, 12, 38) }
    $g.FillRectangle($white, 12, 102, 104, 14)
}

New-Icon "app_house" {
    param($g, $white, $clear)
    $g.FillPolygon($white, [System.Drawing.PointF[]]@((Pt 64 12), (Pt 10 60), (Pt 24 60), (Pt 24 116), (Pt 104 116), (Pt 104 60), (Pt 118 60)))
    Clear-Shape $g { $g.FillPath($clear, (RoundRect 52 76 24 40 4)) }
}

New-Icon "app_gps" {
    param($g, $white, $clear)
    $g.FillEllipse($white, 26, 8, 76, 76)
    $g.FillPolygon($white, [System.Drawing.PointF[]]@((Pt 30 60), (Pt 64 120), (Pt 98 60)))
    Clear-Shape $g { $g.FillEllipse($clear, 48, 30, 32, 32) }
}

New-Icon "app_settings" {
    param($g, $white, $clear)
    $g.TranslateTransform(64, 64)
    for ($i = 0; $i -lt 8; $i++) {
        $g.FillPath($white, (RoundRect -11 -58 22 26 5))
        $g.RotateTransform(45)
    }
    $g.FillEllipse($white, -44, -44, 88, 88)
    Clear-Shape $g { $g.FillEllipse($clear, -18, -18, 36, 36) }
    $g.ResetTransform()
}

Write-Output "phone icons written to $out"
