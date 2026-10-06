/**
 * members region: project members (`components/members/`).
 * Role identifiers stay as the server spells them (viewer / editor / owner /
 * admin); only the explanation after them is translated.
 */
export default {
  roleOption: '{role} ({desc})',
  roleViewer: 'read-only',
  roleEditor: 'can edit',
  roleOwner: 'can manage',
  roleAdmin: 'administrator',
  searchPlaceholder: 'Search by username or display name',
  add: 'Add member',
  pickUserFirst: 'Search for a user and pick one first',
  added: 'Added',
  roleChanged: 'Role updated',
  leaveTitle: 'Leave the project',
  leaveBody: 'Leave “{name}”? You will not see this project afterwards.',
  leaveAction: 'Leave',
  left: 'Left the project',
  removeTitle: 'Remove member',
  removeBody: 'Remove “{name}” from this project?',
  removeAction: 'Remove',
  removed: 'Removed',
  colUsername: 'Username',
  colDisplayName: 'Display name',
  colRole: 'Role',
  me: 'Me',
  disabled: 'Disabled',
  empty: 'No members yet',
  rolesTip: 'Roles: a viewer can only read and send requests; an editor can also add, edit and delete APIs, examples, expectations and environments; an owner can also rename the project, manage members and delete the project. A system administrator counts as owner on every project.',
  keepOwnerTip: 'A project always keeps at least one owner; the last owner cannot be demoted or leave.'
};
