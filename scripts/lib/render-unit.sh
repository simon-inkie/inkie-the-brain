#!/usr/bin/env bash
# render-unit.sh: sourced by the systemd installers.
#
# render_unit TEMPLATE NAME=VALUE... prints TEMPLATE with each @NAME@ replaced
# by VALUE. systemd treats % as a specifier, so a literal % in a value is
# doubled. Replacement is done with bash parameter expansion rather than sed,
# so paths containing /, & or | need no escaping.
render_unit() {
    local template="$1"; shift
    local text pair name value
    text="$(cat "$template")"
    # '&' in a replacement string is special in bash 5.2+; turn that off.
    shopt -u patsub_replacement 2>/dev/null || true
    for pair in "$@"; do
        name="${pair%%=*}"
        value="${pair#*=}"
        value="${value//%/%%}"
        text="${text//@${name}@/$value}"
    done
    printf '%s\n' "$text"
}
