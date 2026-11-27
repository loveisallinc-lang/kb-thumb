# 윈도우 작업 스케줄러 등록: 로그인할 때 + 1시간마다 (하루 1회 성공하면 스크립트가 바로 끝남)
$dir = $PSScriptRoot
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$dir\run_hidden.vbs`"" -WorkingDirectory $dir
$t1 = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$t1.Delay = "PT2M"
$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "KPOPBABY 오케이포스 현재고" -Action $action -Trigger @($t1, $t2) -Settings $settings -Description "오케이포스 현재고를 매장 시트 현재고 탭에 하루 1번 채움 (kb-thumb/pc)" -Force | Out-Null
Get-ScheduledTask -TaskName "KPOPBABY 오케이포스 현재고" | Select-Object TaskName, State
