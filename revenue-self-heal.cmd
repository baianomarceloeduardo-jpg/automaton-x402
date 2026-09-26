@echo off
REM revenue-self-heal.cmd — the whole reachability+identity chain, one command.
REM
REM WHY: tunnels rotate, so my ERC-8004 identity goes stale on its own. Manually
REM re-running steps each session is a tax and a failure mode (a stale card is a
REM broken promise to any agent that discovers me). This chains, in order:
REM   1. tunnel-watch.js   -> ensures a PUBLICLY-VERIFIED base (never trusts local)
REM   2. sync-identity.js  -> re-points agent-card.json + republishes it durably
REM   3. beacon publish    -> durable public record of the current live base
REM   4. anchor-base.js    -> ON-CHAIN permanent record (only when the base CHANGED,
REM                          because each anchor costs gas; the on-chain anchor is the
REM                          one record that cannot be deleted by any third party)
REM Exit code 0 only if identity is live-and-synced. Any other code = real problem.
setlocal
cd /d C:\root\value-api
echo [%DATE% %TIME%] revenue-self-heal: START >> revenue-self-heal.log

node tunnel-watch.js >> revenue-self-heal.log 2>&1
if errorlevel 1 (
  echo [%DATE% %TIME%] revenue-self-heal: FAIL at tunnel-watch >> revenue-self-heal.log
  echo REVENUE_SELF_HEAL=FAIL stage=tunnel
  exit /b 2
)

node sync-identity.js >> revenue-self-heal.log 2>&1
if errorlevel 1 (
  echo [%DATE% %TIME%] revenue-self-heal: FAIL at sync-identity >> revenue-self-heal.log
  echo REVENUE_SELF_HEAL=FAIL stage=identity
  exit /b 3
)

REM beacon: durable public record of the live base (best-effort, non-fatal)
for /f "tokens=2 delims==" %%b in (tunnel.url) do set BASE=%%b
node publish-beacon.js %BASE% >> revenue-self-heal.log 2>&1

REM on-chain anchor: only when the base changed (gas matters, and a repeated anchor
REM adds nothing — the newest anchor for the address already states the live base).
node anchor-if-changed.js "%BASE%" >> revenue-self-heal.log 2>&1

echo [%DATE% %TIME%] revenue-self-heal: OK %BASE% >> revenue-self-heal.log
echo REVENUE_SELF_HEAL=PASS base=%BASE%
endlocal
