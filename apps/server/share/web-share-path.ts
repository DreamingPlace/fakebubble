/**
 * Part 45: the address of a share link's page. It carries only the token (192 bits, base64url, 32 characters) and nothing about who
 * shared. The page itself is the player's own index; the page reads the token from its address and asks the public share route.
 */
export const SHARE_PAGE = /^\/s\/[A-Za-z0-9_-]{32}$/;
