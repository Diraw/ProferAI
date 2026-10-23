#requires -Version 5.1
<#
    PenOcr.ps1 — 用 Windows 自带的 OCR 引擎（Windows.Media.Ocr）识别手写图片

    为什么用 PowerShell：Windows.Media.Ocr 是 WinRT API，Electron 里调用需要原生插件；
    PowerShell 5.1 自带 WinRT 投影，免编译、免安装、免模型下载，是「只用系统能力」
    这条路上最轻的实现。

    用法：
        powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
            -File PenOcr.ps1 -Path <image.png> -OutFile <result.txt>

    说明：
    - 优先用 zh-Hans 引擎，失败回退到用户配置语言
    - 识别结果写文件（UTF-8 无 BOM），避免 stdout 编码在重定向时的坑
    - 未安装对应语言包时抛错，由主进程翻译成「识别不可用」
#>
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$OutFile
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

# 预加载 WinRT 类型投影
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null
[Windows.Globalization.Language,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null

# IAsyncOperation<T> → Task<T> 的同步等待helper
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($operation, $resultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
    $task = $asTask.Invoke($null, @($operation))
    $task.Wait(-1) | Out-Null
    $task.Result
}

if (-not (Test-Path -LiteralPath $Path)) {
    throw "image not found: $Path"
}

$engine = $null
try {
    $language = [Windows.Globalization.Language]::new('zh-Hans')
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
} catch {
    $engine = $null
}
if (-not $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if (-not $engine) {
    throw 'no OCR engine available: 未安装可用的 OCR 语言包'
}

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

if ($bitmap.PixelWidth -gt $engine.MaxImageDimension -or $bitmap.PixelHeight -gt $engine.MaxImageDimension) {
    throw "image too large for Windows OCR: $($bitmap.PixelWidth)x$($bitmap.PixelHeight), max $($engine.MaxImageDimension)"
}

$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

$lines = @()
if ($result -and $result.Lines) {
    foreach ($line in $result.Lines) {
        if ($null -ne $line -and $line.Text) { $lines += $line.Text }
    }
}

$text = ($lines -join "`r`n")
[System.IO.File]::WriteAllText($OutFile, $text, [System.Text.UTF8Encoding]::new($false))
