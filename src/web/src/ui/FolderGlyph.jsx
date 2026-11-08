import { Icon } from './icons.jsx';

/** Line icons offered for folders (stored as "icon:<name>"; emoji are stored as the emoji itself). */
export const FOLDER_ICONS = [
  'folder', 'archive', 'inbox', 'book', 'bookmark', 'file-text', 'clipboard', 'pen', 'kanban', 'calendar', 'clock', 'pin',
  'star', 'heart', 'flag', 'target', 'trophy', 'tag', 'hash', 'lightbulb', 'sparkle', 'zap', 'rocket', 'leaf',
  'briefcase', 'building', 'chart', 'dollar', 'cart', 'gift', 'mail', 'chat', 'megaphone', 'phone', 'user', 'users',
  'home', 'map', 'globe', 'cloud', 'lock', 'key', 'shield', 'code', 'terminal', 'cpu', 'database', 'monitor',
  'wrench', 'flask', 'graduation', 'gamepad', 'palette', 'image', 'camera', 'film', 'video', 'music', 'mic', 'coffee', 'box',
];

export const isLineIcon = (icon) => typeof icon === 'string' && icon.startsWith('icon:');

/** A folder's icon: one of the line icons, an emoji, or the default folder (open when expanded). */
export function FolderGlyph({ icon, open = false, size = 15, class: cls = 'folder-glyph', style }) {
  if (isLineIcon(icon)) return <span class={cls} style={style}><Icon name={icon.slice(5)} size={size} /></span>;
  if (icon) return <span class={cls} style={style}>{icon}</span>;
  return <span class={cls} style={style}><Icon name={open ? 'folder-open' : 'folder'} size={size} /></span>;
}
