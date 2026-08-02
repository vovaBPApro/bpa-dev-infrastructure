#!/usr/bin/env bash
# Bootstrap-local bounded numeric parser. watchdog.sh is copied in tonight's
# allowlist but its NEW helper is not; keep the required fail-closed seam here.
knob_check() {
  local value="$1" min="$2" max="$3"
  KNOB_REASON=""
  if [[ -z "$value" ]]; then KNOB_REASON=empty; return 1; fi
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then KNOB_REASON=non-numeric; return 1; fi
  if (( ${#value} > 12 )); then KNOB_REASON=above-max; return 1; fi
  if (( 10#$value < min )); then KNOB_REASON=below-min; return 1; fi
  if (( 10#$value > max )); then KNOB_REASON=above-max; return 1; fi
}
