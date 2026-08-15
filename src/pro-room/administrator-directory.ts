import type { ProRoomAdministrator } from './contracts.ts';

export function cloneProRoomAdministrators(
  administrators: readonly ProRoomAdministrator[],
): ProRoomAdministrator[] {
  return administrators.map((administrator) => ({
    ...administrator,
    permissions: { ...administrator.permissions },
    inheritedPermissions: [...administrator.inheritedPermissions],
  }));
}

function proRoomAdministratorEqual(
  left: Readonly<ProRoomAdministrator>,
  right: Readonly<ProRoomAdministrator>,
): boolean {
  return (
    left.memberId === right.memberId &&
    left.memberDisplayNumber === right.memberDisplayNumber &&
    left.isAuthenticated === right.isAuthenticated &&
    left.displayName === right.displayName &&
    left.role === right.role &&
    left.onlineDeviceCount === right.onlineDeviceCount &&
    left.permissions['media.add'] === right.permissions['media.add'] &&
    left.permissions['playback.control'] === right.permissions['playback.control'] &&
    left.permissions['members.kick'] === right.permissions['members.kick'] &&
    left.permissions['chat.notice'] === right.permissions['chat.notice'] &&
    left.inheritedPermissions.length === right.inheritedPermissions.length &&
    left.inheritedPermissions.every((permission) => right.inheritedPermissions.includes(permission))
  );
}

function proRoomAdministratorDirectoriesEqual(
  left: readonly ProRoomAdministrator[],
  right: readonly ProRoomAdministrator[],
): boolean {
  return (
    left.length === right.length &&
    left.every((administrator, index) => proRoomAdministratorEqual(administrator, right[index]!))
  );
}

type ProRoomAdministratorDirectoryReconciliation =
  | {
      changed: false;
      /** Detached snapshot safe to publish to UI listeners and API callers. */
      projection: ProRoomAdministrator[];
    }
  | {
      changed: true;
      /** Private snapshot that may be retained by the runtime. */
      accepted: ProRoomAdministrator[];
      /** Detached snapshot safe to publish to UI listeners and API callers. */
      projection: ProRoomAdministrator[];
    };

/**
 * Reconcile a server-owned directory without allowing mutable event/API
 * consumers to alias the runtime's accepted snapshot.
 */
export function reconcileProRoomAdministratorDirectory(
  current: readonly ProRoomAdministrator[],
  incoming: readonly ProRoomAdministrator[],
): ProRoomAdministratorDirectoryReconciliation {
  const next = cloneProRoomAdministrators(incoming);
  if (proRoomAdministratorDirectoriesEqual(current, next)) {
    return {
      projection: cloneProRoomAdministrators(current),
      changed: false,
    };
  }
  return {
    accepted: next,
    projection: cloneProRoomAdministrators(next),
    changed: true,
  };
}
