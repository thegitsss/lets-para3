import { createMatterPicker as createPicker } from '../utils/matter-picker.mjs';
import { statusLabel } from './read-model.mjs';
export { readMatterChoices } from '../utils/matter-picker.mjs';
export function createMatterPicker(options) {
  return createPicker({ ...options, endpoint: '/api/cases/inventory/choices', classPrefix: 'av2', formatStatus: statusLabel });
}
