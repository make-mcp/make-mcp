/** Version strings come from files in other people's repositories and end up in cache paths: only plain version characters. */
export const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+!_~-]{0,63}$/;

export const isSafeVersion = (value: string): boolean => VERSION_PATTERN.test(value) && !value.includes("..");
