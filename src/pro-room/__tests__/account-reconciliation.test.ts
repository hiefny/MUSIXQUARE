import { describe, expect, it, vi } from 'vitest';
import type { AccountSnapshot } from '../../account/state.ts';
import { ProRoomAccountReconciler } from '../account-reconciliation.ts';

interface ProRoomAccountReconciliationViewer {
  isAuthenticated?: boolean;
  displayName: string;
}

interface ProRoomAccountReconciliationAdapter {
  isActive(): boolean;
  viewer(): ProRoomAccountReconciliationViewer | null;
  attach(signal: AbortSignal): Promise<void>;
  detach(signal: AbortSignal): Promise<void>;
  failClosed(): void;
  acceptAuthenticated(): void;
  acceptAnonymous(): void;
  failed(kind: 'attach' | 'detach', error: unknown): void;
}

function accountSnapshot(
  status: 'loading' | 'anonymous' | 'authenticated' | 'unavailable',
  nickname = 'Minsu',
): AccountSnapshot {
  return {
    status,
    configured: status === 'unavailable' || status === 'loading' ? null : true,
    account: status === 'authenticated' ? { nickname, profileComplete: true } : null,
  };
}

function abortable(signal: AbortSignal): Promise<void> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
      once: true,
    });
  });
}

function fixture(initialViewer: ProRoomAccountReconciliationViewer | null) {
  let viewer = initialViewer;
  const adapter = {
    isActive: vi.fn(() => true),
    viewer: vi.fn(() => viewer),
    attach: vi.fn(async () => {
      viewer = { isAuthenticated: true, displayName: 'Minsu' };
    }),
    detach: vi.fn(async () => {
      viewer = { isAuthenticated: false, displayName: 'Peer 2' };
    }),
    failClosed: vi.fn(),
    acceptAuthenticated: vi.fn(),
    acceptAnonymous: vi.fn(),
    failed: vi.fn(),
  } satisfies ProRoomAccountReconciliationAdapter;
  return {
    adapter,
    reconciler: new ProRoomAccountReconciler(adapter),
    setViewer(next: ProRoomAccountReconciliationViewer | null) {
      viewer = next;
    },
  };
}

describe('PRO account-session reconciliation', () => {
  it('detaches a stale authenticated room session on definitive anonymous startup', async () => {
    const { adapter, reconciler } = fixture({ isAuthenticated: true, displayName: 'Minsu' });

    reconciler.update(accountSnapshot('anonymous'));
    expect(adapter.failClosed).toHaveBeenCalledOnce();
    await reconciler.idle();

    expect(adapter.detach).toHaveBeenCalledOnce();
    expect(adapter.attach).not.toHaveBeenCalled();
    expect(adapter.acceptAuthenticated).not.toHaveBeenCalled();
    expect(adapter.acceptAnonymous).toHaveBeenCalledOnce();
  });

  it('does not detach while account state is loading or unavailable', async () => {
    const { adapter, reconciler } = fixture({ isAuthenticated: true, displayName: 'Minsu' });

    reconciler.update(accountSnapshot('loading'));
    reconciler.update(accountSnapshot('unavailable'));
    await reconciler.idle();

    expect(adapter.detach).not.toHaveBeenCalled();
    expect(adapter.failClosed).not.toHaveBeenCalled();
  });

  it('fails closed and detaches the old room account on an incomplete account switch', async () => {
    const { adapter, reconciler } = fixture({ isAuthenticated: true, displayName: 'Minsu' });

    reconciler.update({
      status: 'authenticated',
      configured: true,
      account: { nickname: '', profileComplete: false },
    });
    expect(adapter.failClosed).toHaveBeenCalledOnce();
    await reconciler.idle();

    expect(adapter.detach).toHaveBeenCalledOnce();
    expect(adapter.attach).not.toHaveBeenCalled();
    expect(adapter.acceptAuthenticated).not.toHaveBeenCalled();
  });

  it('leaves initial incomplete-account onboarding anonymous', async () => {
    const { adapter, reconciler } = fixture({ isAuthenticated: false, displayName: 'Peer 2' });

    reconciler.update({
      status: 'authenticated',
      configured: true,
      account: { nickname: '', profileComplete: false },
    });
    await reconciler.idle();

    expect(adapter.failClosed).not.toHaveBeenCalled();
    expect(adapter.detach).not.toHaveBeenCalled();
    expect(adapter.attach).not.toHaveBeenCalled();
    expect(adapter.acceptAnonymous).not.toHaveBeenCalled();
  });

  it('forces detach after aborting an attach that may already have committed', async () => {
    const { adapter, reconciler } = fixture({ isAuthenticated: false, displayName: 'Peer 2' });
    adapter.attach.mockImplementationOnce(abortable);

    reconciler.update(accountSnapshot('authenticated'));
    await vi.waitFor(() => expect(adapter.attach).toHaveBeenCalledOnce());
    const attachSignal = adapter.attach.mock.calls[0]![0];

    reconciler.update(accountSnapshot('anonymous'));
    expect(attachSignal.aborted).toBe(true);
    expect(adapter.failClosed).toHaveBeenCalledOnce();
    await reconciler.idle();

    // The local viewer was already anonymous, but the aborted POST may have
    // committed remotely. A real DELETE is therefore still mandatory.
    expect(adapter.detach).toHaveBeenCalledOnce();
    expect(adapter.acceptAuthenticated).not.toHaveBeenCalled();
    expect(adapter.acceptAnonymous).toHaveBeenCalledOnce();
    expect(adapter.failed).not.toHaveBeenCalled();
  });

  it('forces detach after an attach response fails while the server commit remains uncertain', async () => {
    const { adapter, reconciler } = fixture({
      displayName: 'Peer 2',
      isAuthenticated: false,
    });
    const failure = new Error('attach response lost');
    adapter.attach.mockRejectedValueOnce(failure);

    reconciler.update(accountSnapshot('authenticated', 'Minsu'));
    await reconciler.idle();
    expect(adapter.failed).toHaveBeenCalledWith('attach', failure);

    // The local viewer is still anonymous, but that cannot prove the failed
    // attach was not committed remotely. Logout must issue a real detach.
    reconciler.update(accountSnapshot('anonymous'));
    await reconciler.idle();

    expect(adapter.failClosed).toHaveBeenCalledOnce();
    expect(adapter.detach).toHaveBeenCalledOnce();
    expect(adapter.acceptAnonymous).toHaveBeenCalledOnce();
  });

  it('forces attach after aborting a detach so the latest login wins', async () => {
    const { adapter, reconciler } = fixture({ isAuthenticated: true, displayName: 'Minsu' });
    adapter.detach.mockImplementationOnce(abortable);

    reconciler.update(accountSnapshot('anonymous'));
    await vi.waitFor(() => expect(adapter.detach).toHaveBeenCalledOnce());
    const detachSignal = adapter.detach.mock.calls[0]![0];

    reconciler.update(accountSnapshot('authenticated'));
    expect(detachSignal.aborted).toBe(true);
    await reconciler.idle();

    expect(adapter.attach).toHaveBeenCalledOnce();
    expect(adapter.acceptAuthenticated).toHaveBeenCalledOnce();
    expect(adapter.failed).not.toHaveBeenCalled();
  });

  it('keeps anonymous authority fail-closed when detachment fails', async () => {
    const { adapter, reconciler } = fixture({ isAuthenticated: true, displayName: 'Minsu' });
    const failure = new Error('network unavailable');
    adapter.detach.mockRejectedValueOnce(failure);

    reconciler.update(accountSnapshot('anonymous'));
    expect(adapter.failClosed).toHaveBeenCalledOnce();
    await reconciler.idle();

    expect(adapter.failed).toHaveBeenCalledWith('detach', failure);
    expect(adapter.acceptAuthenticated).not.toHaveBeenCalled();
    expect(adapter.acceptAnonymous).not.toHaveBeenCalled();
  });

  it('re-proves authenticated identity but avoids redundant anonymous detach', async () => {
    const authenticated = fixture({ isAuthenticated: true, displayName: 'Minsu' });
    authenticated.reconciler.update(accountSnapshot('authenticated'));
    await authenticated.reconciler.idle();
    // accountId is intentionally absent from public snapshots. The Worker
    // makes same-account attachment revision-idempotent, so re-proving here
    // also handles a different Google account with the same nickname safely.
    expect(authenticated.adapter.attach).toHaveBeenCalledOnce();
    expect(authenticated.adapter.acceptAuthenticated).toHaveBeenCalledOnce();

    const anonymous = fixture({ isAuthenticated: false, displayName: 'Peer 2' });
    anonymous.reconciler.update(accountSnapshot('anonymous'));
    await anonymous.reconciler.idle();
    expect(anonymous.adapter.detach).not.toHaveBeenCalled();
    expect(anonymous.adapter.failClosed).not.toHaveBeenCalled();
    expect(anonymous.adapter.acceptAnonymous).toHaveBeenCalledOnce();
  });

  it('proves detachment when a legacy viewer omits authentication state', async () => {
    const { adapter, reconciler } = fixture({ displayName: 'Legacy member' });

    reconciler.update(accountSnapshot('anonymous'));
    await reconciler.idle();

    expect(adapter.failClosed).toHaveBeenCalledOnce();
    expect(adapter.detach).toHaveBeenCalledOnce();
    expect(adapter.acceptAnonymous).toHaveBeenCalledOnce();
  });
});
