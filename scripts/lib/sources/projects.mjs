const text = (value) => typeof value === 'string' ? value : '';

const FILES_WARNING = 'Project files were not migrated. Add the original files in AIWP after import.';
const NO_INSTRUCTIONS_WARNING = 'No project instructions were found. If this project has instructions in Claude, add them in AIWP after import.';

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
  if (project.description !== undefined && typeof project.description !== 'string') {
    throw new Error(`Project ${id}: description must be text`);
  }
  const memory = project.memory ?? project.project_memory;
  if (memory !== undefined && typeof memory !== 'string') {
    throw new Error(`Project ${id}: memory must be text`);
  }
  const files = project.files ?? project.docs ?? project.documents;
  const warnings = [
    ...(files && (!Array.isArray(files) || files.length > 0) ? [FILES_WARNING] : []),
    ...(text(instructions).trim() ? [] : [NO_INSTRUCTIONS_WARNING]),
  ];
  return withMemory({
    id,
    name: name.trim(),
    description: text(project.description),
    instructions: text(instructions),
    context: text(project.context),
    ...(warnings.length ? { migrationWarnings: warnings } : {}),
  }, memory);
};

/** Adds project memory when the project has none yet; staged memory wins over the export's. */
export const withMemory = (project, memory) => {
  const value = text(memory).trim();
  return value && !project.memory ? { ...project, memory: value } : project;
};
