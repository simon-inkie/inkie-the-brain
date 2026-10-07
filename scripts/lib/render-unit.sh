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

# check_unit_path PATH: units are written with the path inside double quotes,
# where a backslash or a double quote would need escaping. Real checkouts do not
# have them, so refuse rather than half-escape. Returns 1 when unusable.
check_unit_path() {
    case "$1" in
        *\"*|*\\*|*$'\n'*) return 1 ;;
    esac
    return 0
}

# urlencode_path PATH: percent-encode everything but unreserved characters and
# "/", for the Documentation=file:// line.
urlencode_path() {
    local s="$1" out="" c i
    for ((i = 0; i < ${#s}; i++)); do
        c="${s:i:1}"
        case "$c" in
            [a-zA-Z0-9/._~-]) out+="$c" ;;
            *) out+="$(printf '%%%02X' "'$c")" ;;
        esac
    done
    printf '%s' "$out"
}
