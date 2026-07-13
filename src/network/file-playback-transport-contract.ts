/**
 * Dependency-neutral data-channel frame identities and pre-materialization
 * byte budgets. Low-level transports and higher-level player protocols both
 * import this leaf module so neither layer has to depend on the other.
 */
export const FILE_MEDIA_SOURCE_OFFER_V2_TYPE = 'FILE_MEDIA_SOURCE_OFFER_V2' as const;
export const FILE_MEDIA_SOURCE_OFFER_V2_MAX_RAW_FRAME_BYTES = 4 * 1024;

export const FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_TYPE = 'FILE_MEDIA_SOURCE_OFFER_REVOKE_V2' as const;
export const FILE_MEDIA_SOURCE_OFFER_REVOKE_V2_MAX_RAW_FRAME_BYTES = 4 * 1024;

export const FILE_PLAYBACK_RUN_BINDING_V2_TYPE = 'FILE_PLAYBACK_RUN_BINDING_V2' as const;
export const FILE_PLAYBACK_RUN_BINDING_V2_MAX_RAW_FRAME_BYTES = 4 * 1024;

export const FILE_PLAYBACK_PRODUCT_BASELINE_V2_TYPE = 'FILE_PLAYBACK_PRODUCT_BASELINE_V2' as const;
export const FILE_PLAYBACK_PRODUCT_BASELINE_V2_MAX_RAW_FRAME_BYTES = 4 * 1024;

export const FILE_PLAYBACK_PRODUCT_READY_V2_TYPE = 'FILE_PLAYBACK_PRODUCT_READY_V2' as const;
export const FILE_PLAYBACK_PRODUCT_READY_V2_MAX_RAW_FRAME_BYTES = 1024;

export const FILE_PLAYBACK_TIMELINE_UPDATE_V2_TYPE = 'FILE_PLAYBACK_TIMELINE_UPDATE_V2' as const;
export const FILE_PLAYBACK_TIMELINE_UPDATE_V2_MAX_RAW_FRAME_BYTES = 4 * 1024;
