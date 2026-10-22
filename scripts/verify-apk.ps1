param([string]$ApkPath=(Join-Path $PSScriptRoot '..\output\QuizForge-Android-0.1.0-preview.apk'))
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$assetRoot=Join-Path $projectRoot 'app\src\main\assets'
$archive=[IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($ApkPath))
$verified=0
try {
  foreach($file in Get-ChildItem -LiteralPath $assetRoot -Recurse -File){
    $relative=$file.FullName.Substring($assetRoot.Length+1).Replace('\','/')
    $entry=$archive.GetEntry('assets/'+$relative)
    if(-not $entry){throw ('APK asset missing: '+$relative)}
    $stream=$entry.Open()
    try {
      $hash=[Security.Cryptography.SHA256]::Create()
      try {$actual=[BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','')}finally{$hash.Dispose()}
    }finally{$stream.Dispose()}
    $expected=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    if($actual -ne $expected){throw ('APK asset differs from tested staging: '+$relative)}
    $verified++
  }
  foreach($retired in @('tablet-app.js','tablet.css','ink-board.js','android-library-extras.js')){
    if($archive.GetEntry('assets/web/'+$retired)){throw ('Retired prototype is packaged: '+$retired)}
  }
}finally{$archive.Dispose()}
[ordered]@{verifiedAssets=$verified;retiredPrototypePackaged=$false;apkSha256=(Get-FileHash -LiteralPath $ApkPath -Algorithm SHA256).Hash.ToLowerInvariant()}|ConvertTo-Json
