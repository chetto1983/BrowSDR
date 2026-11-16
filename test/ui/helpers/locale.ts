/*
 * The UI tests assert English number formatting ("12,000 ft"). The app formats with the browser's
 * locale, which is right for users, so pin the test default to en-US instead of the machine's
 * (an Italian Windows prints "12.000 ft" and "2000 ft").
 */
const toLocaleString = Number.prototype.toLocaleString;
Number.prototype.toLocaleString = function (this: number, locales?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions) {
	return toLocaleString.call(this, locales ?? 'en-US', options);
};
