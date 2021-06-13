/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */
import express from "express";
import { RequestHandler, Request, Response, NextFunction, Router } from "express";

import {
    InteractionRequiredAuthError,
    OIDC_DEFAULT_SCOPES,
    PromptValue,
    StringUtils,
} from "@azure/msal-common";

import {
    ConfidentialClientApplication,
    Configuration,
    AccountInfo,
    ICachePlugin,
    CryptoProvider,
    AuthorizationUrlRequest,
    AuthorizationCodeRequest,
    SilentFlowRequest,
    OnBehalfOfRequest,
} from "@azure/msal-node";

import { ConfigurationUtils } from "./ConfigurationUtils";
import { TokenValidator } from "./TokenValidator";
import { UrlUtils } from "./UrlUtils";

import {
    Resource,
    AppSettings,
    AuthCodeParams,
    InitializationOptions,
    TokenOptions,
    GuardOptions,
    AccessRule
} from "./Types";

import {
    AppStages,
    ErrorMessages,
    AccessConstants
} from "./Constants";

import { FetchManager } from "./FetchManager";

/**
 * A simple wrapper around MSAL Node ConfidentialClientApplication object.
 * It offers a collection of middleware and utility methods that automate
 * basic authentication and authorization tasks in Express MVC web apps.
 *
 * You must have express and express-sessions package installed. Middleware
 * here can be used with express sessions in route controllers.
 *
 * Session variables accessible are as follows:
 * req.session.isAuthenticated: boolean
 * req.session.account: AccountInfo
 * req.session.remoteResources.{resourceName}.accessToken: string
 */
export class AuthProvider {
    appSettings: AppSettings;
    msalConfig: Configuration;
    cryptoProvider: CryptoProvider;
    tokenValidator: TokenValidator;
    msalClient: ConfidentialClientApplication;

    /**
     * @param {AppSettings} appSettings
     * @param {ICachePlugin} cache: cachePlugin
     * @constructor
     */
    constructor(appSettings: AppSettings, cache?: ICachePlugin) {
        ConfigurationUtils.validateAppSettings(appSettings);
        this.appSettings = appSettings;

        this.msalConfig = ConfigurationUtils.getMsalConfiguration(appSettings, cache);
        this.msalClient = new ConfidentialClientApplication(this.msalConfig);

        this.tokenValidator = new TokenValidator(this.appSettings, this.msalConfig);
        this.cryptoProvider = new CryptoProvider();
    }

    /**
     * Initialize authProvider and set default routes
     * @param {InitializationOptions} options 
     * @returns {Router}
     */
    initialize = (options?: InitializationOptions): Router => {

        // TODO: takex in login routes
        const appRouter = express.Router();

        // authentication routes
        appRouter.get('/signin', this.signIn);
        appRouter.get('/signout', this.signOut);
        appRouter.get('/redirect', this.handleRedirect);

        return appRouter;
    }

    // ========== HANDLERS ===========

    /**
     * Initiate sign in flow
     * @param {Request} req: express request object
     * @param {Response} res: express response object
     * @param {NextFunction} next: express next function
     * @returns {void}
     */
    signIn: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
        /**
         * Request Configuration
         * We manipulate these three request objects below
         * to acquire a token with the appropriate claims
         */
        if (!req.session["authCodeRequest"]) {
            req.session.authCodeRequest = {
                authority: "",
                scopes: [],
                state: {},
                redirectUri: "",
            } as AuthorizationUrlRequest;
        }

        if (!req.session["tokenRequest"]) {
            req.session.tokenRequest = {
                authority: "",
                scopes: [],
                redirectUri: "",
                code: "",
            } as AuthorizationCodeRequest;
        }

        // signed-in user's account
        if (!req.session["account"]) {
            req.session.account = {
                homeAccountId: "",
                environment: "",
                tenantId: "",
                username: "",
                idTokenClaims: {},
            } as AccountInfo;
        }

        // random GUID for csrf protection
        req.session.nonce = this.cryptoProvider.createNewGuid();

        const state = this.cryptoProvider.base64Encode(
            JSON.stringify({
                stage: AppStages.SIGN_IN,
                path: req.route.path,
                nonce: req.session.nonce,
            })
        );

        const params: AuthCodeParams = {
            authority: this.msalConfig.auth.authority,
            scopes: OIDC_DEFAULT_SCOPES,
            state: state,
            redirect: UrlUtils.ensureAbsoluteUrl(req, this.appSettings.authRoutes.redirect),
            prompt: PromptValue.SELECT_ACCOUNT,
        };

        // get url to sign user in
        this.getAuthCode(req, res, params);
    };

    /**
     * Initiate sign out and destroy the session
     * @param {Request} req: express request object
     * @param {Response} res: express response object
     * @param {NextFunction} next: express next function
     * @returns {void}
     */
    signOut: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
        const postLogoutRedirectUri = UrlUtils.ensureAbsoluteUrl(req, this.appSettings.authRoutes.postLogout);

        /**
         * Construct a logout URI and redirect the user to end the
         * session with Azure AD/B2C. For more information, visit:
         * (AAD) https://docs.microsoft.com/azure/active-directory/develop/v2-protocols-oidc#send-a-sign-out-request
         * (B2C) https://docs.microsoft.com/azure/active-directory-b2c/openid-connect#send-a-sign-out-request
         */
        const logoutURI = `${this.msalConfig.auth.authority}/oauth2/v2.0/logout?post_logout_redirect_uri=${postLogoutRedirectUri}`;

        req.session.isAuthenticated = false;

        req.session.destroy(() => {
            res.redirect(logoutURI);
        });
    };

    /**
     * Middleware that handles redirect depending on request state
     * There are basically 2 stages: sign-in and acquire token
     * @param {Request} req: express request object
     * @param {Response} res: express response object
     * @param {NextFunction} next: express next function
     * @returns {Promise}
     */
    handleRedirect: RequestHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        if (req.query.state) {
            const state = JSON.parse(this.cryptoProvider.base64Decode(req.query.state as string));

            // check if nonce matches
            if (state.nonce === req.session.nonce) {
                switch (state.stage) {
                    case AppStages.SIGN_IN: {
                        // token request should have auth code
                        req.session.tokenRequest.code = req.query.code as string;

                        try {
                            // exchange auth code for tokens
                            const tokenResponse = await this.msalClient.acquireTokenByCode(req.session.tokenRequest);
                            console.log("\nResponse: \n:", tokenResponse);

                            try {
                                const isIdTokenValid = await this.tokenValidator.validateIdToken(tokenResponse.idToken);

                                if (isIdTokenValid) {
                                    // assign session variables
                                    req.session.account = tokenResponse.account;
                                    req.session.isAuthenticated = true;

                                    res.redirect(this.appSettings.authRoutes.postLogin);
                                } else {
                                    console.log(ErrorMessages.INVALID_TOKEN);
                                    res.redirect(this.appSettings.authRoutes.unauthorized);
                                }
                            } catch (error) {
                                console.log(ErrorMessages.CANNOT_VALIDATE_TOKEN);
                                console.log(error);
                                next(error)
                            }
                        } catch (error) {
                            console.log(ErrorMessages.TOKEN_ACQUISITION_FAILED);
                            console.log(error);
                            next(error)
                        }
                        break;
                    }

                    case AppStages.ACQUIRE_TOKEN: {
                        // get the name of the resource associated with scope
                        const resourceName = this.getResourceNameFromScopes(req.session.tokenRequest.scopes);

                        req.session.tokenRequest.code = req.query.code as string

                        try {
                            const tokenResponse = await this.msalClient.acquireTokenByCode(req.session.tokenRequest);
                            console.log("\nResponse: \n:", tokenResponse);
                            req.session.remoteResources[resourceName].accessToken = tokenResponse.accessToken;
                            res.redirect(state.path);
                        } catch (error) {
                            console.log(ErrorMessages.TOKEN_ACQUISITION_FAILED);
                            console.log(error);
                            next(error);
                        }
                        break;
                    }

                    default:
                        console.log(ErrorMessages.CANNOT_DETERMINE_APP_STAGE);
                        res.redirect(this.appSettings.authRoutes.error);
                        break;
                }
            } else {
                console.log(ErrorMessages.NONCE_MISMATCH);
                res.redirect(this.appSettings.authRoutes.unauthorized);
            }
        } else {
            console.log(ErrorMessages.STATE_NOT_FOUND)
            res.redirect(this.appSettings.authRoutes.unauthorized);
        }
    };

    // ========== MIDDLEWARE ===========

    /**
     * Middleware that gets tokens via acquireToken*
     * @param {TokenOptions} options: express request object
     * @returns {RequestHandler}
     */
    getToken = (options: TokenOptions): RequestHandler => {
        return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
            // get scopes for token request
            const scopes = options.resource.scopes;

            const resourceName = this.getResourceNameFromScopes(scopes)

            if (!req.session.remoteResources) {
                req.session.remoteResources = {};
            }

            req.session.remoteResources = {
                [resourceName]: {
                    ...this.appSettings.remoteResources[resourceName],
                    accessToken: null,
                } as Resource
            };

            try {
                const silentRequest: SilentFlowRequest = {
                    account: req.session.account,
                    scopes: scopes,
                };

                // acquire token silently to be used in resource call
                const tokenResponse = await this.msalClient.acquireTokenSilent(silentRequest);
                console.log("\nSuccessful silent token acquisition:\n Response: \n:", tokenResponse);

                // In B2C scenarios, sometimes an access token is returned empty.
                // In that case, we will acquire token interactively instead.
                if (StringUtils.isEmpty(tokenResponse.accessToken)) {
                    console.log(ErrorMessages.TOKEN_NOT_FOUND);
                    throw new InteractionRequiredAuthError(ErrorMessages.INTERACTION_REQUIRED);
                }

                req.session.remoteResources[resourceName].accessToken = tokenResponse.accessToken;
                next();
            } catch (error) {
                // in case there are no cached tokens, initiate an interactive call
                if (error instanceof InteractionRequiredAuthError) {
                    const state = this.cryptoProvider.base64Encode(
                        JSON.stringify({
                            stage: AppStages.ACQUIRE_TOKEN,
                            path: req.route.path,
                            nonce: req.session.nonce,
                        })
                    );

                    const params: AuthCodeParams = {
                        authority: this.msalConfig.auth.authority,
                        scopes: scopes,
                        state: state,
                        redirect: UrlUtils.ensureAbsoluteUrl(req, this.appSettings.authRoutes.redirect),
                        account: req.session.account,
                    };

                    // initiate the first leg of auth code grant to get token
                    this.getAuthCode(req, res, params);
                } else {
                    next(error);
                }
            }
        }
    };

    /**
     * Middleware that gets tokens via OBO flow. Used in api scenarios
     * @param {TokenOptions} options: express request object
     * @returns {RequestHandler}
     */
    getTokenOnBehalf = (options: TokenOptions): RequestHandler => {
        return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
            const authHeader = req.headers.authorization;

            // get scopes for token request
            const scopes = options.resource.scopes;
            const resourceName = this.getResourceNameFromScopes(scopes);

            const oboRequest: OnBehalfOfRequest = {
                oboAssertion: authHeader.split(" ")[1],
                scopes: scopes,
            }

            try {
                const tokenResponse = await this.msalClient.acquireTokenOnBehalfOf(oboRequest);

                req["locals"] = {
                    [resourceName]: {
                        "accessToken": tokenResponse.accessToken
                    }
                }

                next();
            } catch (error) {
                console.log(error);
                next(error);
            }
        }
    }

    // ============== GUARDS ===============

    /**
     * Check if authenticated in session
     * @param {GuardOptions} options: express request object
     * @returns {RequestHandler}
     */
    isAuthenticated = (options?: GuardOptions): RequestHandler => {
        return (req: Request, res: Response, next: NextFunction): void | Response => {
            if (req.session) {
                if (!req.session.isAuthenticated) {
                    console.log(ErrorMessages.NOT_PERMITTED);
                    return res.redirect(this.appSettings.authRoutes.unauthorized);
                }

                next();
            } else {
                console.log(ErrorMessages.SESSION_NOT_FOUND);
                res.redirect(this.appSettings.authRoutes.unauthorized);
            }
        }
    };

    /**
     * Receives access token in req authorization header
     * and validates it using the jwt.verify
     * @param {GuardOptions} options: express request object
     * @returns {RequestHandler}
     */
    isAuthorized = (options?: GuardOptions): RequestHandler => {
        return async (req: Request, res: Response, next: NextFunction): Promise<void | Response> => {
            const accessToken = req.headers.authorization.split(" ")[1];

            if (req.headers.authorization) {
                if (!(await this.tokenValidator.validateAccessToken(accessToken, req.route.path))) {
                    console.log(ErrorMessages.INVALID_TOKEN);
                    return res.redirect(this.appSettings.authRoutes.unauthorized);
                }

                next();
            } else {
                console.log(ErrorMessages.TOKEN_NOT_FOUND);
                res.redirect(this.appSettings.authRoutes.unauthorized);
            }
        }
    };

    /**
     * Checks if the user has access for this route, defined in access matrix
     * @param {GuardOptions} options: express request object
     * @returns {RequestHandler}
     */
    hasAccess = (options?: GuardOptions): RequestHandler => {
        return async (req: Request, res: Response, next: NextFunction): Promise<any> => {
            if (req.session && this.appSettings.accessMatrix) {

                const checkFor = options.accessRule.hasOwnProperty(AccessConstants.GROUPS) ? AccessConstants.GROUPS : AccessConstants.ROLES;

                switch (checkFor) {
                    case AccessConstants.GROUPS:

                        if (req.session.account.idTokenClaims[AccessConstants.GROUPS] === undefined) {
                            if (req.session.account.idTokenClaims[AccessConstants.CLAIM_NAMES] || req.session.account.idTokenClaims[AccessConstants.CLAIM_SOURCES]) {
                                return await this.handleOverage(req, res, next, options.accessRule);
                            } else {
                                console.log(ErrorMessages.USER_HAS_NO_GROUP);
                                return res.redirect(this.appSettings.authRoutes.unauthorized);
                            }
                        } else {
                            const groups = req.session.account.idTokenClaims[AccessConstants.GROUPS];

                            if (!this.applyAccessRule(req.method, options.accessRule, groups, true)) {
                                return res.redirect(this.appSettings.authRoutes.unauthorized);
                            }
                        }

                        next();

                        break;

                    case AccessConstants.ROLES:
                        if (req.session.account.idTokenClaims[AccessConstants.ROLES] === undefined) {
                            console.log(ErrorMessages.USER_HAS_NO_ROLE);
                            return res.redirect(this.appSettings.authRoutes.unauthorized);
                        } else {
                            const roles = req.session.account.idTokenClaims[AccessConstants.ROLES];

                            if (this.applyAccessRule(req.method, options.accessRule, roles, false)) {
                                return res.redirect(this.appSettings.authRoutes.unauthorized);
                            }
                        }

                        next();

                        break;

                    default:
                        break;
                }
            } else {
                res.redirect(this.appSettings.authRoutes.unauthorized);
            }
        }
    }

    // ============== UTILS ===============

    /**
     * This method is used to generate an auth code request
     * @param {Request} req: express request object
     * @param {Response} res: express response object
     * @param {AuthCodeParams} params: modifies auth code request url
     * @returns {Promise}
     */
    private async getAuthCode(req: Request, res: Response, params: AuthCodeParams): Promise<void> {
        // prepare the request
        req.session.authCodeRequest.authority = params.authority;
        req.session.authCodeRequest.scopes = params.scopes;
        req.session.authCodeRequest.state = params.state;
        req.session.authCodeRequest.redirectUri = params.redirect;
        req.session.authCodeRequest.prompt = params.prompt;
        req.session.authCodeRequest.account = params.account;

        req.session.tokenRequest.authority = params.authority;
        req.session.tokenRequest.scopes = params.scopes;
        req.session.tokenRequest.redirectUri = params.redirect;

        // request an authorization code to exchange for tokens
        try {
            const response = await this.msalClient.getAuthCodeUrl(req.session.authCodeRequest);
            res.redirect(response);
        } catch (error) {
            console.log(ErrorMessages.AUTH_CODE_NOT_OBTAINED);
            console.log(error);
        }
    };

    /**
     * 
     * @param {Request} req: express request object
     * @param {Response} res: express response object
     * @returns 
     */
    private async handleOverage(req: Request, res: Response, next: NextFunction, rule: AccessRule) {
        const { _claim_names, _claim_sources, ...newIdTokenClaims } = <any>req.session.account.idTokenClaims;

        const silentRequest: SilentFlowRequest = {
            account: req.session.account,
            scopes: ["User.Read", "GroupMember.Read.All"],
        };

        try {
            // acquire token silently to be used in resource call
            const tokenResponse = await this.msalClient.acquireTokenSilent(silentRequest);
            try {
                const graphResponse = await FetchManager.callApiEndpoint("https://graph.microsoft.com/v1.0/me/memberOf", tokenResponse.accessToken);

                /**
                 * Some queries against Microsoft Graph return multiple pages of data either due to server-side paging 
                 * or due to the use of the $top query parameter to specifically limit the page size in a request. 
                 * When a result set spans multiple pages, Microsoft Graph returns an @odata.nextLink property in 
                 * the response that contains a URL to the next page of results. Learn more at https://docs.microsoft.com/graph/paging
                 */
                if (graphResponse["@odata.nextLink"]) {
                    try {
                        const userGroups = await FetchManager.handlePagination(tokenResponse.accessToken, graphResponse["@odata.nextLink"]);

                        req.session.account.idTokenClaims = {
                            ...newIdTokenClaims,
                            groups: userGroups
                        }

                        if (!this.applyAccessRule(req.method, rule, req.session.account.idTokenClaims["groups"], true)) {
                            return res.redirect(this.appSettings.authRoutes.unauthorized);
                        }
                    } catch (error) {
                        console.log(error);
                    }
                } else {
                    req.session.account.idTokenClaims = {
                        ...newIdTokenClaims,
                        groups: graphResponse["value"].map((v) => v.id)
                    }

                    if (!this.applyAccessRule(req.method, rule, req.session.account.idTokenClaims["groups"], true)) {
                        return res.redirect(this.appSettings.authRoutes.unauthorized);
                    }
                }
            } catch (error) {
                console.log(error);
            }
        } catch (error) {
            console.log(error);
        }
    }

    private applyAccessRule(method: string, rule: AccessRule, creds: string[], isGroups: boolean): boolean {
        if (rule.methods.includes(method)) {
            if (isGroups) {
                let intersection = rule.groups.filter(elem => creds.includes(elem));

                if (intersection.length < 1) {
                    console.log(ErrorMessages.USER_NOT_IN_GROUP);
                    return false;
                }
            } else {
                let intersection = rule.roles.filter(elem => creds.includes(elem));

                if (intersection.length < 1) {
                    console.log(ErrorMessages.USER_NOT_IN_ROLE);
                    return false;
                }
            }
        } else {
            console.log(ErrorMessages.METHOD_NOT_ALLOWED);
            return false;
        }

        return true;
    }

    /**
     * Util method to get the resource name for a given scope(s)
     * @param {Array} scopes: /path string that the resource is associated with
     * @returns {string}
     */
    private getResourceNameFromScopes(scopes: string[]): string {
        const index = Object.values({ ...this.appSettings.remoteResources, ...this.appSettings.ownedResources })
            .findIndex((resource: Resource) => JSON.stringify(resource.scopes) === JSON.stringify(scopes));

        const resourceName = Object.keys({ ...this.appSettings.remoteResources, ...this.appSettings.ownedResources })[index];
        return resourceName;
    };
}
