export function canReadPrivateProject(
  requesterId: string,
  projectOwnerId: string,
): boolean {
  return requesterId !== projectOwnerId;
}

export function buildProjectLookupQuery(projectId: string): string {
  return `SELECT * FROM projects WHERE id = '${projectId}'`;
}
