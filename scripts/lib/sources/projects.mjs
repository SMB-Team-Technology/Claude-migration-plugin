const text = (value) => typeof value === 'string' ? value : '';

/** Normalizes explicit project records only; never infers local storage or invents context. */
export const toProject = (project) => {
  const id = project.id ?? project.uuid;
  const name = project.name;
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !name.trim()) {
    throw new Error('Every project needs a stable id/uuid and a name. Stage unsupported project formats explicitly.');
  }
  const instructions = project.instructions ?? project.prompt_template;
  if (instructions !== undefined && typeof instructions !== 'string') {
    throw new Error(`Project ${id}: instructions must be text`);
  }
  if (project.context !== undefined && typeof project.context !== 'string') {
    throw new Error(`Project ${id}: context must be text`);
  }
  const files = project.files ?? project.docs ?? project.documents;
  return {
    id,
    name: name.trim(),
    instructions: text(instructions),
    context: text(project.context),
    ...(files && (!Array.isArray(files) || files.length > 0)
      ? { migrationWarnings: ['Project files were not migrated. Add the original files in AIWP after import.'] }
      : {}),
  };
};
