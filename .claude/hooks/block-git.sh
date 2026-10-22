cmd=$(jq -r '.tool_input.command')
if echo "$cmd" | grep -Eq 'git\b.*\b(commit|push|add)\b'; then
  echo "Bloqueado: commits e pushes são feitos apenas pelo usuário." >&2
  exit 2
fi
exit 0
