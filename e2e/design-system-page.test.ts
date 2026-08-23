import { expect, test } from '@playwright/test';

const VIEWPORTS = [
  { height: 800, width: 360 },
  { height: 844, width: 390 },
  { height: 390, width: 844 },
  { height: 900, width: 719 },
  { height: 900, width: 720 },
  { height: 1024, width: 768 },
  { height: 900, width: 899 },
  { height: 900, width: 900 },
  { height: 768, width: 1024 },
  { height: 800, width: 1280 },
  { height: 900, width: 1600 },
] as const;

test('keeps the Design System rail and examples coherent at every layout size', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto('/designsystem');
    await expect(page.locator('h1')).toHaveText(/Design\s*language\./u);
    const rails = await page.evaluate(() => {
      const hero = document.querySelector<HTMLElement>('.hero')!;
      const heroRect = hero.getBoundingClientRect();
      const heroStyle = getComputedStyle(hero);
      const logoRect = hero.querySelector('.logo')!.getBoundingClientRect();
      return {
        footer: document.querySelector('footer')!.getBoundingClientRect().width,
        hero: heroRect.width,
        heroContentLeft: heroRect.left + Number.parseFloat(heroStyle.paddingLeft),
        heroContentRight: heroRect.right - Number.parseFloat(heroStyle.paddingRight),
        logoLeft: logoRect.left,
        logoRight: logoRect.right,
        page: document.querySelector('.page')!.getBoundingClientRect().width,
      };
    });
    expect(Math.abs(rails.hero - rails.footer)).toBeLessThan(1);
    expect(Math.abs(rails.hero - rails.page)).toBeLessThan(1);
    expect(rails.logoLeft).toBeGreaterThanOrEqual(rails.heroContentLeft - 1);
    expect(rails.logoRight).toBeLessThanOrEqual(rails.heroContentRight + 1);

    await page.locator('#foundations').scrollIntoViewIfNeeded();
    const foundations = await page.evaluate(() => {
      const section = document.querySelector<HTMLElement>('#foundations')!;
      const stack = section.querySelector<HTMLElement>('.theme-palette-stack')!;
      const boards = [...section.querySelectorAll<HTMLElement>('.theme-palette')];
      const bands = [...section.querySelectorAll<HTMLElement>('.palette-band')];
      const sectionRect = section.getBoundingClientRect();
      const stackRect = stack.getBoundingClientRect();
      const stackStyle = getComputedStyle(stack);
      const darkPalette = section.querySelector<HTMLElement>('[data-palette="dark"]')!;
      const darkContext = darkPalette.querySelector<HTMLElement>('.palette-context')!;
      const darkSpectrum = darkPalette.querySelector<HTMLElement>('.palette-spectrum')!;
      const darkContextStyle = getComputedStyle(darkContext);

      return {
        bandRects: bands.map((band) => {
          const rect = band.getBoundingClientRect();
          const token = band.querySelector('strong')!.getBoundingClientRect();
          const hex = band.querySelector('code')!.getBoundingClientRect();
          const board = band.closest<HTMLElement>('.theme-palette')!;
          return {
            contextHeight: board.querySelector('.palette-context')!.getBoundingClientRect().height,
            flexDirection: getComputedStyle(band).flexDirection,
            height: rect.height,
            hexTop: hex.top,
            spectrumWidth: band.closest('.palette-spectrum')!.getBoundingClientRect().width,
            tokenBottom: token.bottom,
            width: rect.width,
          };
        }),
        boardAlignment: boards.map((board) => {
          const boardRect = board.getBoundingClientRect();
          const contextRect = board.querySelector('.palette-context')!.getBoundingClientRect();
          const spectrumRect = board.querySelector('.palette-spectrum')!.getBoundingClientRect();
          return {
            context:
              Math.abs(contextRect.left - boardRect.left) < 1 &&
              Math.abs(contextRect.right - boardRect.right) < 1,
            spectrum:
              Math.abs(spectrumRect.left - boardRect.left) < 1 &&
              Math.abs(spectrumRect.right - boardRect.right) < 1,
          };
        }),
        boardBandOrders: boards.map((board) =>
          [...board.querySelectorAll<HTMLElement>('.palette-band')].map(
            (band) => band.dataset.token,
          ),
        ),
        boardRects: boards.map((board) => {
          const rect = board.getBoundingClientRect();
          return {
            bottom: rect.bottom,
            left: rect.left,
            palette: board.dataset.palette,
            right: rect.right,
            top: rect.top,
            width: rect.width,
          };
        }),
        boardRadii: boards.map((board) => getComputedStyle(board).borderRadius),
        boardTitlesInsideContext: boards.every(
          (board) => board.querySelector('.palette-context > .theme-palette-title') !== null,
        ),
        boardTitles: boards.map((board) => ({
          level: board.querySelector('.theme-palette-title')?.tagName,
          palette: board.dataset.palette,
          text: board.querySelector('.theme-palette-title')?.textContent?.trim(),
        })),
        boardTokens: boards.map((board) => board.querySelectorAll('[data-token]').length),
        boardWidths: boards.map((board) => board.getBoundingClientRect().width),
        darkContextStroke: {
          borderBottomWidth: darkContextStyle.borderBottomWidth,
          borderTopWidth: darkContextStyle.borderTopWidth,
          bottomGap:
            darkSpectrum.getBoundingClientRect().top - darkContext.getBoundingClientRect().bottom,
          boxShadow: darkContextStyle.boxShadow,
        },
        directChildCount: stack.children.length,
        legacyVisualCount: section.querySelectorAll(
          '.palette-family-stack, .palette-mode-group, .palette-mode-title, .semantic-palette, .semantic-spectrum, .semantic-band, .semantic-fill-block',
        ).length,
        sectionRect: { left: sectionRect.left, right: sectionRect.right, width: sectionRect.width },
        stack: {
          backgroundColor: stackStyle.backgroundColor,
          borderRadius: stackStyle.borderRadius,
          left: stackRect.left,
          padding: [
            stackStyle.paddingTop,
            stackStyle.paddingRight,
            stackStyle.paddingBottom,
            stackStyle.paddingLeft,
          ],
          right: stackRect.right,
          rowGap: stackStyle.rowGap,
          width: stackRect.width,
        },
        textHierarchyCount: section.querySelectorAll('.palette-text').length,
      };
    });

    expect(foundations.boardTitles).toEqual([
      { level: 'H3', palette: 'dark', text: 'Dark' },
      { level: 'H3', palette: 'light', text: 'Light' },
      { level: 'H3', palette: 'contrast-dark', text: 'High contrast dark' },
      { level: 'H3', palette: 'contrast-light', text: 'High contrast light' },
    ]);
    expect(foundations.boardBandOrders).toEqual(
      Array.from({ length: 4 }, () => [
        '--primary',
        '--surface-1',
        '--surface-2',
        '--surface-3',
        '--divider',
      ]),
    );
    expect(foundations.directChildCount).toBe(4);
    expect(foundations.legacyVisualCount).toBe(0);
    expect(foundations.stack.backgroundColor).toBe('rgb(26, 26, 26)');
    expect(foundations.stack.borderRadius).toBe('0px');
    expect(foundations.stack.padding).toEqual(['0px', '0px', '0px', '0px']);
    expect(foundations.stack.rowGap).toBe('0px');
    expect(Math.abs(foundations.stack.left - foundations.sectionRect.left)).toBeLessThan(1);
    expect(Math.abs(foundations.stack.right - foundations.sectionRect.right)).toBeLessThan(1);
    expect(Math.abs(foundations.stack.width - foundations.sectionRect.width)).toBeLessThan(1);
    expect(foundations.boardWidths).toHaveLength(4);
    expect(foundations.boardTitlesInsideContext).toBe(true);
    expect(
      foundations.boardWidths.every((width) => Math.abs(width - foundations.stack.width / 2) < 1),
    ).toBe(true);
    expect(foundations.boardAlignment.every(({ context, spectrum }) => context && spectrum)).toBe(
      true,
    );
    const dark = foundations.boardRects.find(({ palette }) => palette === 'dark')!;
    const light = foundations.boardRects.find(({ palette }) => palette === 'light')!;
    const contrastDark = foundations.boardRects.find(({ palette }) => palette === 'contrast-dark')!;
    const contrastLight = foundations.boardRects.find(
      ({ palette }) => palette === 'contrast-light',
    )!;
    expect(Math.abs(dark.left - foundations.stack.left)).toBeLessThan(1);
    expect(Math.abs(light.left - foundations.stack.left)).toBeLessThan(1);
    expect(Math.abs(contrastDark.right - foundations.stack.right)).toBeLessThan(1);
    expect(Math.abs(contrastLight.right - foundations.stack.right)).toBeLessThan(1);
    expect(Math.abs(dark.right - contrastDark.left)).toBeLessThan(1);
    expect(Math.abs(light.right - contrastLight.left)).toBeLessThan(1);
    expect(Math.abs(dark.top - contrastDark.top)).toBeLessThan(1);
    expect(Math.abs(light.top - contrastLight.top)).toBeLessThan(1);
    expect(Math.abs(dark.bottom - light.top)).toBeLessThan(1);
    expect(Math.abs(contrastDark.bottom - contrastLight.top)).toBeLessThan(1);
    expect(foundations.darkContextStroke.borderTopWidth).toBe('0px');
    expect(foundations.darkContextStroke.borderBottomWidth).toBe('0px');
    expect(Math.abs(foundations.darkContextStroke.bottomGap)).toBeLessThan(1);
    expect(foundations.darkContextStroke.boxShadow).toContain('rgb(38, 38, 38)');
    expect(foundations.darkContextStroke.boxShadow.match(/inset/gu)).toHaveLength(2);
    expect(foundations.darkContextStroke.boxShadow).toMatch(/1px 0px 0px 0px inset/u);
    expect(foundations.darkContextStroke.boxShadow).not.toMatch(/-1px 0px 0px 0px inset/u);
    expect(foundations.darkContextStroke.boxShadow).toMatch(/0px 1px 0px 0px inset/u);
    expect(foundations.darkContextStroke.boxShadow).not.toMatch(/0px -1px 0px 0px inset/u);
    expect(foundations.boardRadii).toEqual(['0px', '0px', '0px', '0px']);
    expect(foundations.boardTokens).toEqual([9, 9, 9, 9]);
    expect(foundations.textHierarchyCount).toBe(12);
    expect(foundations.bandRects).toHaveLength(20);
    expect(
      foundations.bandRects.every(
        ({ contextHeight, height, spectrumWidth, width }) =>
          Math.abs(width - spectrumWidth) < 1 &&
          Math.abs(height - 72) < 1 &&
          height < contextHeight,
      ),
    ).toBe(true);
    expect(foundations.bandRects.every(({ flexDirection }) => flexDirection === 'column')).toBe(
      true,
    );
    expect(foundations.bandRects.every(({ hexTop, tokenBottom }) => tokenBottom < hexTop)).toBe(
      true,
    );
    expect(
      await page
        .locator('#foundations')
        .evaluate((section) =>
          ['Default theme', 'Light theme', 'Increased contrast', 'Reserved semantic fills'].every(
            (copy) => !section.textContent?.includes(copy),
          ),
        ),
    ).toBe(true);

    await page.locator('#components').scrollIntoViewIfNeeded();
    const components = await page.evaluate(() => {
      const playback = document.querySelector<HTMLElement>('.playback-comp')!;
      const selection = document.querySelector<HTMLElement>('.selection-comp')!;
      const ranges = document.querySelector<HTMLElement>('.ranges-comp')!;
      const playlist = document.querySelector<HTMLElement>('.playlist-comp')!;
      const devices = document.querySelector<HTMLElement>('.device-comp')!;
      const messaging = document.querySelector<HTMLElement>('.messaging-comp')!;
      const interfaceSample = document.querySelector<HTMLElement>('.interface-comp')!;
      const feedback = document.querySelector<HTMLElement>('.feedback-comp')!;
      const navigation = document.querySelector<HTMLElement>('.nav-comp')!;
      const toast = feedback.querySelector<HTMLElement>('.toast')!;
      const dialog = feedback.querySelector<HTMLElement>('.dialog')!;
      const expand = document.querySelector<HTMLButtonElement>(
        '#components .playlist-entry-sample:nth-child(3) .expand-toggle',
      )!;
      const expandRect = expand.getBoundingClientRect();
      const expandSvg = expand.querySelector('svg')!;
      const expandSvgRect = expandSvg.getBoundingClientRect();
      const remove = expand.nextElementSibling;
      const wrappers = [...document.querySelectorAll<HTMLElement>('#components .comp')];
      const iconSamples = [...document.querySelectorAll<HTMLElement>('.icon-grid .icon-sample')];
      const iconTiles = [...document.querySelectorAll<HTMLElement>('.icon-grid .ic')];
      const tokenReference = document.querySelector<HTMLElement>('.token-reference')!;
      const playbackRect = playback.getBoundingClientRect();
      const selectionRect = selection.getBoundingClientRect();
      const rangesRect = ranges.getBoundingClientRect();
      const playlistRect = playlist.getBoundingClientRect();
      const devicesRect = devices.getBoundingClientRect();
      const messagingRect = messaging.getBoundingClientRect();
      const interfaceRect = interfaceSample.getBoundingClientRect();
      const feedbackRect = feedback.getBoundingClientRect();
      const navigationRect = navigation.getBoundingClientRect();
      const toastRect = toast.getBoundingClientRect();
      const dialogRect = dialog.getBoundingClientRect();
      const rangeProgressPropertyRule = [...document.styleSheets]
        .flatMap((stylesheet) => {
          try {
            return [...stylesheet.cssRules];
          } catch {
            return [];
          }
        })
        .find((rule) => rule.cssText.startsWith('@property --range-progress'));
      const rangeProgressProbe = document.createElement('div');
      const rangeProgressProbeChild = document.createElement('span');
      rangeProgressProbe.style.setProperty('--range-progress', '38%');
      rangeProgressProbe.append(rangeProgressProbeChild);
      document.body.append(rangeProgressProbe);
      const inheritedRangeProgress = getComputedStyle(rangeProgressProbeChild)
        .getPropertyValue('--range-progress')
        .trim();
      rangeProgressProbe.remove();

      return {
        dialogRadii: [...document.querySelectorAll<HTMLElement>('.dialog-actions > button')].map(
          (button) => getComputedStyle(button).borderRadius,
        ),
        horizontalOverflow:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
        iconSamplesTransparent: iconSamples.every(
          (sample) => getComputedStyle(sample).backgroundColor === 'rgba(0, 0, 0, 0)',
        ),
        iconTilesTransparent: iconTiles.every(
          (tile) => getComputedStyle(tile).backgroundColor === 'rgba(0, 0, 0, 0)',
        ),
        rangeControls: {
          count: document.querySelectorAll('.design-range').length,
          eqCount: document.querySelectorAll('.design-range-eq').length,
          eqHeight: document
            .querySelector<HTMLElement>('.range-eq-container')!
            .getBoundingClientRect().height,
          allVisible: [...document.querySelectorAll<HTMLElement>('.design-range')].every(
            (range) => {
              const rect = range.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            },
          ),
          effectWidth: document
            .querySelector<HTMLElement>('.range-effect-demo')!
            .getBoundingClientRect().width,
          volumeProgress: getComputedStyle(
            document.querySelector<HTMLElement>('.design-range-volume')!,
          )
            .getPropertyValue('--range-progress')
            .trim(),
          volumeSliderWidth: document
            .querySelector<HTMLElement>('.design-range-volume')!
            .getBoundingClientRect().width,
          volumeSpecimenWidth: document
            .querySelector<HTMLElement>('.range-volume-demo')!
            .getBoundingClientRect().width,
          inheritedProgress: inheritedRangeProgress,
          propertyRule: rangeProgressPropertyRule?.cssText ?? '',
        },
        interfacePatterns: {
          tabCount: document.querySelectorAll('.settings-subtab-sample .subtab-pill').length,
          composerWidth: document
            .querySelector<HTMLElement>('.chat-input-wrapper')!
            .getBoundingClientRect().width,
          searchWidth: document
            .querySelector<HTMLElement>('.yt-search-input-wrapper')!
            .getBoundingClientRect().width,
          spinnerSize: document
            .querySelector<HTMLElement>('.material-elastic-spinner--large')!
            .getBoundingClientRect().width,
          spinnerBackground: getComputedStyle(
            document.querySelector<HTMLElement>('.large-spinner-stage')!,
          ).backgroundColor,
          headerHeight: document
            .querySelector<HTMLElement>('.app-loading-header-demo')!
            .getBoundingClientRect().height,
          headerBadgeDot: !!document.querySelector('.app-loading-header-badge i'),
          headerProgress: !!document.querySelector('.app-loading-header-progress'),
        },
        playlistRemoval: {
          actionCount: document.querySelectorAll('.playlist-selection-pill button').length,
          count: document.querySelector('.playlist-selection-count')?.textContent?.trim(),
          selectedHalo: !!document.querySelector('.btn-playlist-remove.is-selected'),
        },
        expandedLists: {
          deviceCount: document.querySelectorAll('.device-subrow-sample').length,
          deviceVisible: [...document.querySelectorAll<HTMLElement>('.device-subrow-sample')].every(
            (row) => row.getBoundingClientRect().height > 0,
          ),
          playlistCount: document.querySelectorAll('.sub-track-item').length,
          playlistVisible: [...document.querySelectorAll<HTMLElement>('.sub-track-item')].every(
            (row) => row.getBoundingClientRect().height > 0,
          ),
        },
        playlistHeaderActions: [
          ...document.querySelectorAll<HTMLButtonElement>('.tab-action-btn-sample'),
        ].map((button) => button.getAttribute('aria-label')),
        playlistHeaderOwner: {
          label: document
            .querySelector('.playlist-comp > .playlist-area-header .lbl')
            ?.textContent?.trim(),
          playbackCount: document.querySelectorAll('.playback-comp .tab-action-btn-sample').length,
          playlistCount: document.querySelectorAll('.playlist-comp .tab-action-btn-sample').length,
        },
        volumeCycle: {
          mutedMarks: document.querySelectorAll('.volume-cycle-demo .volume-muted-mark').length,
          waves: document.querySelectorAll('.volume-cycle-demo .volume-wave').length,
        },
        deviceActions: [...document.querySelectorAll<HTMLElement>('.device-row-sample button')].map(
          (button) => {
            const rect = button.getBoundingClientRect();
            return { height: rect.height, width: rect.width };
          },
        ),
        physicalDeviceActions: [
          ...document.querySelectorAll<HTMLButtonElement>('.btn-kick-physical-device'),
        ].map((button) => {
          const rect = button.getBoundingClientRect();
          return {
            height: rect.height,
            label: button.getAttribute('aria-label'),
            width: rect.width,
          };
        }),
        motionRecipes: {
          borderless: [...document.querySelectorAll<HTMLElement>('.motion-card')].every(
            (card) => getComputedStyle(card).borderWidth === '0px',
          ),
          noteMaxWidth: getComputedStyle(document.querySelector<HTMLElement>('.motion-note')!)
            .maxWidth,
        },
        chatContained: [...document.querySelectorAll<HTMLElement>('.chat-demo-stage .chat-bubble')]
          .map((bubble) => bubble.getBoundingClientRect())
          .every(
            (bubble) => bubble.left >= messagingRect.left && bubble.right <= messagingRect.right,
          ),
        groupedOutgoingRows: document.querySelectorAll('.chat-group.mine:not(.whisper) > .chat-row')
          .length,
        playlistExpand: {
          action: expand.dataset.action,
          ariaExpanded: expand.getAttribute('aria-expanded'),
          ariaLabel: expand.getAttribute('aria-label'),
          beforeRemove: remove?.classList.contains('playlist-remove') ?? false,
          height: expandRect.height,
          svgHeight: expandSvgRect.height,
          svgWidth: expandSvgRect.width,
          width: expandRect.width,
        },
        feedback: {
          bottom: feedbackRect.bottom,
          top: feedbackRect.top,
          width: feedbackRect.width,
        },
        navigation: { top: navigationRect.top, width: navigationRect.width },
        messaging: {
          bottom: messagingRect.bottom,
          top: messagingRect.top,
          width: messagingRect.width,
        },
        interfaceSample: {
          top: interfaceRect.top,
          width: interfaceRect.width,
        },
        playback: { bottom: playbackRect.bottom, top: playbackRect.top, width: playbackRect.width },
        selection: {
          bottom: selectionRect.bottom,
          top: selectionRect.top,
          width: selectionRect.width,
        },
        ranges: { top: rangesRect.top, width: rangesRect.width },
        playlist: {
          bottom: playlistRect.bottom,
          top: playlistRect.top,
          width: playlistRect.width,
        },
        devices: { top: devicesRect.top, width: devicesRect.width },
        toastBeforeDialog: toastRect.bottom < dialogRect.top,
        tokenOverflow: tokenReference.scrollWidth - tokenReference.clientWidth,
        wrappersTransparent: wrappers.every((wrapper) => {
          const style = getComputedStyle(wrapper);
          return style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.borderWidth === '0px';
        }),
      };
    });

    expect(components.horizontalOverflow).toBe(0);
    expect(components.tokenOverflow).toBe(0);
    expect(components.wrappersTransparent).toBe(true);
    expect(components.iconSamplesTransparent).toBe(true);
    expect(components.iconTilesTransparent).toBe(true);
    expect(components.rangeControls).toEqual(
      expect.objectContaining({
        allVisible: true,
        count: 8,
        eqCount: 5,
        eqHeight: 160,
        inheritedProgress: '38%',
        propertyRule: expect.stringMatching(/inherits:\s*true/iu),
        volumeProgress: '0%',
      }),
    );
    expect(components.rangeControls.volumeSpecimenWidth).toBeLessThanOrEqual(141);
    expect(components.rangeControls.volumeSliderWidth).toBeLessThan(
      components.rangeControls.volumeSpecimenWidth,
    );
    expect(components.rangeControls.effectWidth).toBeGreaterThan(
      components.rangeControls.volumeSpecimenWidth,
    );
    expect(components.interfacePatterns.tabCount).toBe(4);
    expect(components.interfacePatterns.composerWidth).toBeGreaterThan(0);
    expect(components.interfacePatterns.searchWidth).toBeGreaterThan(0);
    expect(components.interfacePatterns.spinnerSize).toBe(36);
    expect(components.interfacePatterns.spinnerBackground).toBe('rgb(32, 32, 32)');
    expect(components.interfacePatterns.headerHeight).toBe(60);
    expect(components.interfacePatterns.headerBadgeDot).toBe(true);
    expect(components.interfacePatterns.headerProgress).toBe(true);
    expect(components.playlistHeaderActions).toEqual(['Repeat one', 'Shuffle', 'Add media']);
    expect(components.playlistHeaderOwner).toEqual({
      label: 'Playlist area',
      playbackCount: 0,
      playlistCount: 3,
    });
    expect(components.volumeCycle).toEqual({ mutedMarks: 1, waves: 2 });
    expect(components.playlistRemoval).toEqual({
      actionCount: 3,
      count: '1',
      selectedHalo: true,
    });
    expect(components.expandedLists).toEqual({
      deviceCount: 4,
      deviceVisible: true,
      playlistCount: 4,
      playlistVisible: true,
    });
    expect(components.deviceActions).toEqual([
      { height: 28, width: 28 },
      { height: 32, width: 32 },
      { height: 28, width: 28 },
    ]);
    expect(components.physicalDeviceActions).toEqual([
      { height: 28, label: 'Remove macOS device (A1B2)', width: 28 },
      { height: 28, label: 'Remove Windows device (C3D4)', width: 28 },
      { height: 28, label: 'Remove iOS device (E5F6)', width: 28 },
      { height: 28, label: 'Remove Android device (G7H8)', width: 28 },
    ]);
    expect(components.motionRecipes).toEqual({ borderless: true, noteMaxWidth: 'none' });
    expect(components.chatContained).toBe(true);
    expect(components.groupedOutgoingRows).toBe(2);
    expect(components.playlistExpand).toEqual({
      action: 'expand',
      ariaExpanded: 'true',
      ariaLabel: 'Expand/collapse playlist',
      beforeRemove: true,
      height: 44,
      svgHeight: 22,
      svgWidth: 22,
      width: 44,
    });
    expect(components.dialogRadii).toEqual(['999px', '999px']);
    expect(components.toastBeforeDialog).toBe(true);
    if (viewport.width >= 900) {
      expect(Math.abs(components.playback.top - components.ranges.top)).toBeLessThan(1);
      expect(components.selection.top).toBeGreaterThanOrEqual(components.playback.bottom);
      expect(components.ranges.width).toBeGreaterThan(components.playback.width);
      expect(Math.abs(components.playlist.top - components.devices.top)).toBeLessThan(1);
      expect(Math.abs(components.playlist.width - components.devices.width)).toBeLessThan(1);
      expect(Math.abs(components.messaging.top - components.interfaceSample.top)).toBeLessThan(1);
      expect(components.messaging.width).toBeGreaterThan(components.interfaceSample.width);
      expect(Math.abs(components.feedback.top - components.navigation.top)).toBeLessThan(1);
      expect(components.navigation.width).toBeGreaterThan(components.feedback.width);
    } else {
      expect(components.selection.top).toBeGreaterThanOrEqual(components.playback.bottom);
      expect(components.ranges.top).toBeGreaterThanOrEqual(components.selection.bottom);
      expect(components.devices.top).toBeGreaterThanOrEqual(components.playlist.bottom);
      expect(components.interfaceSample.top).toBeGreaterThanOrEqual(components.messaging.bottom);
      expect(components.navigation.top).toBeGreaterThanOrEqual(components.feedback.bottom);
    }
  }

  expect(consoleErrors).toEqual([]);
});
