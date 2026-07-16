export { FileEditorPanel, type FileEditorPanelProps } from './FileEditorPanel.js';
export { MonacoTextEditor, type MonacoTextEditorProps } from './MonacoTextEditor.js';
export {
  ProjectFileBrowser,
  type ProjectFileBrowserProps,
  type ProjectFileSelection,
} from './browser/ProjectFileBrowser.js';
export type { ProjectFileBrowserOperations } from './browser/useProjectFileBrowser.js';
export type { FileEditorOperations } from './operations.js';
export {
  FileEditorWorkspace,
  type FileEditorTabRequest,
  type FileEditorTabTarget,
} from './tabs/FileEditorWorkspace.js';
