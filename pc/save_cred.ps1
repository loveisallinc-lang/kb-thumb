# 오케이포스 아이디/비밀번호를 이 PC 이 계정에서만 풀 수 있게 암호화해서 cred.dat 에 저장
Set-Location -LiteralPath $PSScriptRoot
Write-Host ""
Write-Host "오케이포스 로그인 정보를 저장합니다. (이 PC, 이 윈도우 계정에서만 쓸 수 있게 암호화돼요)"
$u = Read-Host "오케이포스 아이디"
$p = Read-Host "오케이포스 비밀번호" -AsSecureString
Set-Content -LiteralPath (Join-Path $PSScriptRoot "cred.dat") -Value @($u, (ConvertFrom-SecureString $p)) -Encoding ASCII
Write-Host ""
Write-Host "저장했어요. 이 창은 닫으셔도 돼요."
Read-Host "엔터를 누르면 닫혀요"
