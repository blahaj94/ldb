export function canReadPrivateDocument({ requesterId, ownerId }) {
  if (!requesterId || !ownerId) {
    return false;
  }

  return requesterId !== ownerId;
}
