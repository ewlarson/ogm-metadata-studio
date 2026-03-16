/**
 * Minimal type declarations for Google Identity Services (GIS).
 * @see https://developers.google.com/identity/gsi/web/reference/js-reference
 */
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(config: IdConfiguration): void;
          prompt(): void;
          renderButton(
            parent: HTMLElement,
            options: {
              theme?: "outline" | "filled_blue" | "filled_black";
              size?: "large" | "medium" | "small";
              type?: "standard" | "icon";
              text?: "signin_with" | "signup_with" | "continue_with" | "signin";
              callback?: (credential: CredentialResponse) => void;
            }
          ): void;
        };
      };
    };
  }
}

export interface CredentialResponse {
  credential: string;
  clientId: string;
  select_by?: string;
}

export interface IdConfiguration {
  client_id: string;
  callback: (response: CredentialResponse) => void;
  auto_select?: boolean;
  ux_mode?: "popup" | "redirect";
  cancel_on_tap_outside?: boolean;
}

export {};
