/** Capability report types, kept separate so tools can import them cheaply. */

export type BluditEdition = 'community' | 'pro' | 'unknown';

export interface EndpointSupport {
  supported: true | false | 'documented';
  note: string;
}

export interface SiteCapabilities {
  checkedAt: number;
  edition: {
    /** What the site owner declared when connecting. Not verified. */
    declared: BluditEdition;
    /** What the MCP server could verify independently. Bludit exposes no version endpoint. */
    detected: BluditEdition;
    note: string;
  };
  bluditApi: {
    reachable: boolean;
    /** Unauthenticated (API token only) reads work. */
    readOk: boolean;
    /** Authenticated (user auth token) reads work, implying writes will too. */
    authenticatedOk: boolean;
    readError: string;
    authenticatedError: string;
  };
  endpoints: {
    pages: EndpointSupport;
    settings: EndpointSupport;
    tags: EndpointSupport;
    categories: EndpointSupport;
    users: EndpointSupport;
    files: EndpointSupport;
    images: EndpointSupport;
    search: EndpointSupport;
  };
  wizardExtension: {
    available: boolean;
    path: string;
    reason: string;
    capabilities: string[];
  };
  notes: string[];
}
