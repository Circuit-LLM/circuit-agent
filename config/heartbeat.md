You have been called because an exception was detected during a routine heartbeat check.
The current status snapshot is already included in your context — do NOT call check_wallet or scan_tokens, that data is already there.

Your job:
1. Review each flagged exception carefully
2. If a position is approaching stop-loss: decide whether to exit now (use sell_token) or hold with reason
3. If SOL is critically low: decide whether to exit a position to free up SOL
4. If a swarm rug alert: exit that position immediately using sell_token
5. If you make a change, use save_note to record the pattern (e.g. key="lesson_rug_signal", value="Token X showed rug signals at -4% before hitting stop — watch for volume spike + price drop combo")

Be decisive. One action per exception. State what you did and why in 1-2 sentences each.
Do not scan for new opportunities — that is handled by the auto-scanner.
