param([switch]$SkipTests,[switch]$Offline,[string]$JavaHome,[string]$SdkRoot)
$ErrorActionPreference='Stop'
Set-Location -LiteralPath $PSScriptRoot
if(-not $JavaHome){$JavaHome=Join-Path $env:ProgramFiles 'Android\Android Studio\jbr'}
if(-not(Test-Path -LiteralPath (Join-Path $JavaHome 'bin\java.exe'))){throw 'Set -JavaHome to JDK 17 or newer (Android Studio jbr recommended).'}
if(-not $SdkRoot){$SdkRoot=if($env:ANDROID_HOME){$env:ANDROID_HOME}else{Join-Path $env:LOCALAPPDATA 'Android\Sdk'}}
if(-not(Test-Path -LiteralPath (Join-Path $SdkRoot 'platforms\android-36'))){throw 'Android SDK platform 36 is required. Set -SdkRoot if installed elsewhere.'}
$sdkLine='sdk.dir='+$SdkRoot.Replace('\','/').Replace(':','\:')
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'local.properties'),$sdkLine+"`n",[Text.UTF8Encoding]::new($false))
if(-not(Test-Path -LiteralPath 'node_modules\ajv')){& npm ci --no-audit --no-fund --cache .temp/npm-cache;if($LASTEXITCODE -ne 0){throw 'npm ci failed.'}}
& npm run prepare:assets;if($LASTEXITCODE -ne 0){throw 'Asset build failed.'}
$acceptanceRoot=Join-Path $PSScriptRoot 'output\acceptance'
New-Item -ItemType Directory -Path $acceptanceRoot -Force | Out-Null
if(-not $SkipTests){
  $testLogPath=Join-Path $acceptanceRoot 'javascript-tests.txt'
  & npm test 2>&1 | Tee-Object -FilePath $testLogPath
  $testExit=$LASTEXITCODE
  [IO.File]::WriteAllText($testLogPath,(Get-Content -LiteralPath $testLogPath -Raw),[Text.UTF8Encoding]::new($false))
  if($testExit -ne 0){throw 'Compatibility tests failed.'}
}
$previousJava=$env:JAVA_HOME
try{
  $env:JAVA_HOME=$JavaHome
  $arguments=@('assembleDebug','lintDebug','--console=plain','--no-daemon')
  if($Offline){$arguments+='--offline'}
  & .\gradlew.bat @arguments
  if($LASTEXITCODE -ne 0){throw 'Android build failed.'}
  $out=Join-Path $PSScriptRoot 'output'
  New-Item -ItemType Directory -Path $out -Force | Out-Null
  $apk=Join-Path $out 'QuizForge-Android-0.1.0-preview.apk'
  Copy-Item -LiteralPath 'app\build\outputs\apk\debug\app-debug.apk' -Destination $apk
  $digest=(Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText(($apk+'.sha256'),$digest+'  '+[IO.Path]::GetFileName($apk)+"`n",[Text.UTF8Encoding]::new($false))
  $verification=& (Join-Path $PSScriptRoot 'scripts\verify-apk.ps1') -ApkPath $apk
  $verification | Write-Output
  [IO.File]::WriteAllText((Join-Path $acceptanceRoot 'apk-verification.json'),($verification | Out-String),[Text.UTF8Encoding]::new($false))
  Copy-Item -LiteralPath 'app\build\reports\lint-results-debug.txt' -Destination (Join-Path $acceptanceRoot 'lint-results.txt')
  if(-not $SkipTests){& node scripts/write-build-info.mjs;if($LASTEXITCODE -ne 0){throw 'Build evidence validation failed.'}}
  Write-Output ('APK: '+$apk)
  Write-Output ('SHA256: '+$digest)
}finally{$env:JAVA_HOME=$previousJava}
