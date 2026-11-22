export const engineLabel = 'Native C++17';
export const engineError = 'Unable to connect to the C++ backend. Run ./start.sh from the project root.';

export async function readState() {
  const response = await fetch('/api/state', {cache: 'no-store'});
  if (!response.ok) throw new Error(engineError);
  return response.json();
}

export async function sendAction(action, value) {
  const response = await fetch('/api/action', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({action, value})
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Action failed');
  return result;
}

export async function exportSession() {
  const response = await fetch('/api/export', {cache: 'no-store'});
  if (!response.ok) throw new Error('Unable to export the session.');
  return response.blob();
}
