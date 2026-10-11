// Paths as shown on screen: the home folder becomes `~`, so a recording or screenshot doesn't carry
// the account name. Only for display; anything sent to the server keeps the real path.
export const tildify = (p: string) => p.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~');
