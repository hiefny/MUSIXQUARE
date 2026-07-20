import type { DeviceInfo, RoomCapability } from '../types/index.ts';

export interface ConnectedRoomMember {
  /** Room-scoped identity key. Anonymous legacy devices intentionally remain device-scoped. */
  key: string;
  memberId: string | null;
  memberDisplayNumber: number;
  label: string;
  isAuthenticated: boolean;
  isCurrent: boolean;
  /** Whether this browser's physical connection is the ordinary-room host. */
  isCurrentDeviceHost: boolean;
  /** Whether this browser's physical connection itself carries administrator authority. */
  isCurrentDeviceAdministrator: boolean;
  /** Physical host connection inside this person-level row, when present. */
  hostDeviceId: string | null;
  isHost: boolean;
  isAdministrator: boolean;
  /** Union of the effective capabilities carried by this member's live devices. */
  capabilities: RoomCapability[];
  deviceCount: number;
  deviceIds: string[];
  firstJoinOrder: number;
  status: string;
}

interface MutableRoomMember extends ConnectedRoomMember {
  hasCanonicalDisplayNumber: boolean;
}

function safeOrder(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function memberKey(device: Readonly<DeviceInfo>): { key: string; memberId: string | null } {
  const id = typeof device.memberId === 'string' ? device.memberId.trim() : '';
  return id
    ? { key: `member:${id}`, memberId: id }
    : { key: `device:${device.id}`, memberId: null };
}

/**
 * Convert physical room connections into the person-level rows shown by the
 * connection UI. Display text is never an identity key: two accounts may use
 * the same nickname, while several devices from one account share a memberId.
 */
export function groupConnectedRoomMembers(
  devices: readonly Readonly<DeviceInfo>[],
  currentDeviceId: string,
): ConnectedRoomMember[] {
  const grouped = new Map<string, MutableRoomMember>();

  devices.forEach((device, index) => {
    if (!device || typeof device.id !== 'string' || !device.id) return;
    const identity = memberKey(device);
    const joinOrder = safeOrder(device.joinOrder, index);
    const canonicalNumber = safeOrder(device.memberDisplayNumber, joinOrder);
    const hasCanonicalDisplayNumber =
      typeof device.memberDisplayNumber === 'number' &&
      Number.isSafeInteger(device.memberDisplayNumber) &&
      device.memberDisplayNumber >= 0;
    const label =
      typeof device.label === 'string' && device.label.trim() ? device.label.trim() : '';
    const existing = grouped.get(identity.key);

    if (!existing) {
      grouped.set(identity.key, {
        key: identity.key,
        memberId: identity.memberId,
        memberDisplayNumber: canonicalNumber,
        label,
        isAuthenticated: device.isAuthenticated === true,
        isCurrent: device.id === currentDeviceId,
        isCurrentDeviceHost: device.id === currentDeviceId && device.isHost === true,
        isCurrentDeviceAdministrator:
          device.id === currentDeviceId && (device.isOp === true || device.isHost === true),
        hostDeviceId: device.isHost === true ? device.id : null,
        isHost: device.isHost === true,
        isAdministrator: device.isOp === true || device.isHost === true,
        capabilities: [...new Set(device.capabilities || [])],
        deviceCount: 1,
        deviceIds: [device.id],
        firstJoinOrder: joinOrder,
        status: device.status,
        hasCanonicalDisplayNumber,
      });
      return;
    }

    existing.deviceCount += 1;
    existing.deviceIds.push(device.id);
    existing.isAuthenticated ||= device.isAuthenticated === true;
    existing.isCurrent ||= device.id === currentDeviceId;
    existing.isCurrentDeviceHost ||= device.id === currentDeviceId && device.isHost === true;
    existing.isCurrentDeviceAdministrator ||=
      device.id === currentDeviceId && (device.isOp === true || device.isHost === true);
    if (!existing.hostDeviceId && device.isHost === true) existing.hostDeviceId = device.id;
    existing.isHost ||= device.isHost === true;
    existing.isAdministrator ||= device.isOp === true || device.isHost === true;
    for (const capability of device.capabilities || []) {
      if (!existing.capabilities.includes(capability)) existing.capabilities.push(capability);
    }
    if (device.status === 'connected') existing.status = 'connected';
    if (joinOrder < existing.firstJoinOrder) {
      existing.firstJoinOrder = joinOrder;
      if (label) existing.label = label;
    }
    if (
      hasCanonicalDisplayNumber &&
      (!existing.hasCanonicalDisplayNumber || canonicalNumber < existing.memberDisplayNumber)
    ) {
      existing.memberDisplayNumber = canonicalNumber;
      existing.hasCanonicalDisplayNumber = true;
    }
  });

  return [...grouped.values()]
    .sort(
      (left, right) =>
        left.memberDisplayNumber - right.memberDisplayNumber ||
        left.firstJoinOrder - right.firstJoinOrder ||
        left.key.localeCompare(right.key),
    )
    .map(({ hasCanonicalDisplayNumber: _ignored, ...member }) => member);
}
