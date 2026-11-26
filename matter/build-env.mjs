// Public build config shared by ship-local.mjs and live-ui.mjs, the same values as the
// workflow's repository variables.
export const BUILD_ENV = {
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
  T3CODE_DESKTOP_UPDATE_REPOSITORY: "current/matter",
  T3CODE_CLERK_PUBLISHABLE_KEY: "pk_live_Y2xlcmsudDMuY29kZXMk",
  T3CODE_CLERK_JWT_TEMPLATE: "t3-relay",
  T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "hzxSgY2cH10sDU2r",
  T3CODE_RELAY_URL: "https://relay.t3.codes",
};
