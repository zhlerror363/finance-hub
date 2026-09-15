<#
.SYNOPSIS
    finance-hub PM2 安全守卫：只接受「具体服务名」，明确拒绝 all / 通配 / 进程 ID。

.DESCRIPTION
    本脚本是一层参数校验外壳，不是 PM2 的替代品。它做且只做三件事：
      1) 在调用 PM2 之前拦掉所有「批量 / 无差别」目标（all、*、正则、进程 ID）；
      2) 默认只允许操作本项目（finance-hub）自己的服务名，操作别的项目需显式 -AllowForeign；
      3) 在执行 pm2 save 前校验本项目服务仍在 PM2 列表中（防止把「服务已丢失」的列表固化下来）。

    背景（2026-09-14 真实事故，非假设）：
    阿里云服务器上 finance-hub 与 wrist-shell 等多个项目共用同一个 PM2 daemon。
    另一项目的部署动作执行了 pm2 delete all，把 finance-hub 一并从 PM2 进程列表删除；
    随后的 pm2 save 又把「无 finance-hub」的列表写成开机恢复列表。
    结果：finance-hub 停止服务且不再开机自启，只能靠外部健康检查兜底拉回。
    关键机制：PM2 只在「进程崩溃」时重启，进程从列表里消失它管不着。

    完整禁令与运维规范见同仓库 deploy/PM2-安全禁令.md。

.PARAMETER Action
    要执行的 PM2 动作。list/status/describe/logs 为只读；start/stop/restart/reload/delete/save 为写操作。

.PARAMETER Name
    目标服务名，必须是具体名称（例如 finance-hub）。写操作必填。

.PARAMETER DryRun
    只打印将要执行的 PM2 命令，不真正执行。建议先跑一次 DryRun 确认目标无误。

.PARAMETER AllowForeign
    允许操作不属于本项目白名单的服务名。用于维护其它项目，属于跨项目操作，需自行确认影响面。

.EXAMPLE
    pwsh -File scripts\pm2-safe.ps1 -Action describe -Name finance-hub
    查看 finance-hub 的 PM2 状态（只读）。

.EXAMPLE
    pwsh -File scripts\pm2-safe.ps1 -Action stop -Name finance-hub -DryRun
    演练停服：只打印命令，不执行。确认无误后去掉 -DryRun。

.EXAMPLE
    pwsh -File scripts\pm2-safe.ps1 -Action delete -Name all
    被拒绝，退出码 4。这就是本脚本存在的意义。

.NOTES
    · 文件编码必须为 UTF-8 with BOM（Windows PowerShell 5.1 会把无 BOM 的 UTF-8 按 GBK 解码，
      导致中文注释与提示乱码、甚至静默解析错误）。
    · 退出码：0 成功 / 2 参数被拒 / 3 环境缺失（pm2 不可用）/ 4 危险目标被拒 / 5 save 前置校验未通过 / 1 执行失败。
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('list', 'status', 'describe', 'logs', 'start', 'stop', 'restart', 'reload', 'delete', 'save', 'kill')]
    [string]$Action,

    [Parameter(Position = 1)]
    [string]$Name = '',

    [switch]$DryRun,

    [switch]$AllowForeign
)

$ErrorActionPreference = 'Stop'

# ===== 本项目白名单：只有这些服务名可以被本脚本默认为「自己人」 =====
# 新增本项目服务时在此追加；不要为了省事用 -AllowForeign 绕过。
$ProjectOwnedServices = @('finance-hub')

# ===== 危险目标识别：这些写法在 PM2 里表示「所有进程」，一律拒绝 =====
$ForbiddenTargets = @('all', 'any', '*', '.*', '--all', '-a')

# ===== 需要显式服务名的动作（save 作用于整份列表，故不需要） =====
$ActionsNeedingName = @('describe', 'logs', 'start', 'stop', 'restart', 'reload', 'delete')

function Fail {
    param([string]$Message, [int]$Code)
    Write-Host ''
    Write-Host ('[拒绝] ' + $Message) -ForegroundColor Red
    Write-Host ''
    exit $Code
}

function Show-Usage {
    Write-Host ''
    Write-Host 'finance-hub PM2 安全守卫 —— 用法' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '  pwsh -File scripts\pm2-safe.ps1 -Action <动作> -Name <服务名> [-DryRun] [-AllowForeign]'
    Write-Host ''
    Write-Host '  只读动作：list | status | describe | logs'
    Write-Host '  写动作　：start | stop | restart | reload | delete | save'
    Write-Host ''
    Write-Host '  正确示例：'
    Write-Host '    pwsh -File scripts\pm2-safe.ps1 -Action describe -Name finance-hub'
    Write-Host '    pwsh -File scripts\pm2-safe.ps1 -Action stop     -Name finance-hub -DryRun'
    Write-Host '    pwsh -File scripts\pm2-safe.ps1 -Action restart  -Name finance-hub'
    Write-Host ''
    Write-Host '  被拒绝的写法（本脚本会直接拦下）：' -ForegroundColor Yellow
    Write-Host '    -Action delete -Name all      会连带干掉其它项目，禁用'
    Write-Host '    -Action stop   -Name "*"      通配，禁用'
    Write-Host '    -Action delete -Name 3        按进程 ID 定位，ID 会漂移，禁用（请用服务名）'
    Write-Host '    -Action kill                  会杀掉整个 PM2 daemon，禁用'
    Write-Host ''
    Write-Host '  停止本项目服务的正确方式：pm2 stop finance-hub'
    Write-Host '  彻底移除本项目服务（谨慎）：pm2 delete finance-hub'
    Write-Host ''
}

# ===== 1. 无条件拒绝的动作 =====
if ($Action -eq 'kill') {
    $m = @'
动作 kill 已禁用。
pm2 kill 会杀掉整个 PM2 daemon，同一台机器上所有项目（含其它项目）的受管进程会全部停止。
需要停止本项目服务请使用：-Action stop -Name finance-hub
需要彻底移除本项目服务请使用：-Action delete -Name finance-hub
'@
    Fail $m 4
}

# ===== 2. 目标名校验 =====
$Trimmed = ''
if ($null -ne $Name) { $Trimmed = ([string]$Name).Trim() }

$NeedName = ($ActionsNeedingName -contains $Action)

if ([string]::IsNullOrWhiteSpace($Trimmed)) {
    if ($NeedName) {
        Show-Usage
        Fail ("动作 '" + $Action + "' 必须显式指定 -Name <服务名>，不接受省略目标。") 2
    }
} else {
    # 2a. 批量目标
    if ($ForbiddenTargets -contains $Trimmed.ToLowerInvariant()) {
        $m = @'
目标 BAD_TARGET 表示「所有 PM2 进程」，已禁止。
本机多个项目共用同一个 PM2 daemon，批量操作会连带停掉或删除其它项目的服务，
并可能被 pm2 save 固化成开机状态（2026-09-14 finance-hub 事故即由此产生）。
请改用具体服务名，例如：-Action ACTION_NAME -Name finance-hub
'@
        $m = $m.Replace('BAD_TARGET', ("'" + $Trimmed + "'"))
        $m = $m.Replace('ACTION_NAME', $Action)
        Fail $m 4
    }

    # 2b. 通配符
    if ($Trimmed -match '[\*\?\[\]]') {
        Fail ("目标 '" + $Trimmed + "' 含通配符。本脚本只接受精确服务名，不接受模式匹配（模式匹配可能命中其它项目）。") 4
    }

    # 2c. 纯数字（PM2 进程 ID 会在进程增删后重新分配，按 ID 操作极易误伤）
    if ($Trimmed -match '^\d+$') {
        Fail ("目标 '" + $Trimmed + "' 是 PM2 进程 ID。ID 会在进程增删后重新分配，按 ID 操作容易误伤其它项目；请改用服务名，例如 -Name finance-hub。") 4
    }

    # 2d. 跨项目白名单
    if (($ProjectOwnedServices -notcontains $Trimmed) -and (-not $AllowForeign)) {
        $m = @'
服务名不在本项目白名单内。这属于跨项目操作。
白名单内容：WHITELIST
确认影响面后，加 -AllowForeign 显式放行：
    -Action ACTION_NAME -Name SERVICE_NAME -AllowForeign
'@
        $m = $m.Replace('WHITELIST', ($ProjectOwnedServices -join ', '))
        $m = $m.Replace('ACTION_NAME', $Action)
        $m = $m.Replace('SERVICE_NAME', $Trimmed)
        Fail $m 2
    }
}

# ===== 3. 确认 pm2 可用 =====
$Pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
if ($null -eq $Pm2) {
    Write-Host ''
    Write-Host '[环境缺失] 当前环境找不到 pm2 命令。' -ForegroundColor Yellow
    Write-Host '  本脚本只是参数校验外壳，真正的 PM2 操作仍由 pm2 本体执行。'
    Write-Host '  · 若在开发机上：这是正常的，PM2 只装在服务器上。'
    Write-Host '  · 若在服务器上：请检查 PATH，或改用 deploy/pm2-safe.sh。'
    Write-Host '  未执行任何操作，未改动任何服务。'
    Write-Host ''
    exit 3
}

# ===== 4. save 前置校验：防止把「服务已丢失」固化进开机恢复列表 =====
# 这正是 2026-09-14 事故的第二半段：先被 delete all 清掉，再被 save 写死。
if ($Action -eq 'save') {
    if ($DryRun.IsPresent) {
        Write-Host '[DryRun] 将先执行前置校验，确认以下服务仍在 PM2 列表中：' -ForegroundColor Cyan
        foreach ($svc in $ProjectOwnedServices) { Write-Host ('    · ' + $svc) }
    } else {
        $Raw = ''
        try { $Raw = (& pm2 jlist 2>$null | Out-String) } catch { $Raw = '' }
        if ([string]::IsNullOrWhiteSpace($Raw)) {
            Fail '无法读取 PM2 进程列表（pm2 jlist 无输出）。为避免把错误状态固化，已中止 save。' 5
        }
        $Live = @()
        try {
            $Parsed = @(ConvertFrom-Json $Raw)
            foreach ($p in $Parsed) { if ($p.name) { $Live += [string]$p.name } }
        } catch {
            Fail ('PM2 进程列表无法解析，为避免把错误状态固化，已中止 save。原因：' + $_.Exception.Message) 5
        }
        $Missing = @()
        foreach ($svc in $ProjectOwnedServices) { if ($Live -notcontains $svc) { $Missing += $svc } }
        if ($Missing.Count -gt 0) {
            $m = @'
pm2 save 已中止：以下本项目服务当前不在 PM2 列表中 —— MISSING_LIST
此刻 save 会把「服务已丢失」的状态固化成开机恢复列表（正是 2026-09-14 事故的成因）。
请先恢复服务，再执行 save。在项目目录下执行：
    pm2 start "node --experimental-sqlite server/index.js" --name finance-hub
    scripts\pm2-safe.ps1 -Action save
'@
            $m = $m.Replace('MISSING_LIST', ($Missing -join ', '))
            Fail $m 5
        }
        Write-Host ('[前置校验通过] 本项目服务均在 PM2 列表中（应存在 ' + $ProjectOwnedServices.Count + ' 个，缺失 0 个）。') -ForegroundColor Green
    }
}

# ===== 5. 组装并执行 =====
$Pm2Args = @($Action)
if (-not [string]::IsNullOrWhiteSpace($Trimmed)) { $Pm2Args += $Trimmed }

$Rendered = 'pm2 ' + ($Pm2Args -join ' ')

if ($DryRun.IsPresent) {
    Write-Host ''
    Write-Host '[DryRun] 校验通过，将要执行的命令为：' -ForegroundColor Cyan
    Write-Host ('    ' + $Rendered)
    Write-Host '  未真正执行，未改动任何服务。'
    Write-Host ''
    exit 0
}

Write-Host ('[执行] ' + $Rendered) -ForegroundColor DarkGray
& pm2 @Pm2Args
$Code = $LASTEXITCODE
if ($null -eq $Code) { $Code = 0 }

if ($Code -eq 0) {
    Write-Host ('[完成] ' + $Rendered) -ForegroundColor Green
} else {
    Write-Host ('[失败] ' + $Rendered + ' （退出码 ' + $Code + '）') -ForegroundColor Red
}
exit $Code
