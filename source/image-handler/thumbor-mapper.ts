// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import Color from 'color';
import ColorName from 'color-name';

import {ImageEdits, ImageFitTypes, ImageFormatTypes} from './lib';

export class ThumborMapper {
    private static readonly EMPTY_IMAGE_EDITS: ImageEdits = {};

    /**
     * Initializer function for creating a new Thumbor mapping, used by the image
     * handler to perform image modifications based on legacy URL path requests.
     * @param path The request path.
     * @returns Image edits based on the request path.
     */
    public mapPathToEdits(path: string): ImageEdits {
        const PATH_REGEX = /(?<=\/)(?<fit>((?:adaptive-|full-)?fit-in)?(?=\/))?\/?(?<resize>(\d+x\d+)(?=\/))?\/?(?<crop>\d+x\d+:\d+x\d+(?=\/))?\/?(?<filters>(filters:[^\/]+\/?)*)\/?(?<smart>smart(?=\/))?/;
        const matchObject = PATH_REGEX.exec(path);
        const fileFormat = path.substring(path.lastIndexOf('.') + 1) as ImageFormatTypes;

        let edits: ImageEdits = this.mergeEdits(this.mapCrop(matchObject.groups.crop ?? ''), this.mapFitIn(matchObject.groups.fit ?? ''), this.mapSmartCrop(matchObject.groups.smart ?? ''));

        // parse the image path. we have to sort here to make sure that when we have a file name without extension,
        // and `format` and `quality` filters are passed, then the `format` filter will go first to be able
        // to apply the `quality` filter to the target image format.
        const filters = matchObject.groups.filters.split('/').sort();
        for (const filter of filters) {
            edits = this.mapFilter(filter.replace('/', ''), fileFormat, edits);
        }

        edits = this.mergeEdits(edits, this.mapResize(matchObject.groups.resize ?? '', matchObject.groups.smart ?? '', matchObject.groups.crop ?? '', matchObject.groups.filters ?? ''));

        return edits;
    }

    /**
     * Enables users to migrate their current image request model to the SIH solution,
     * without changing their legacy application code to accommodate new image requests.
     * @param path The URL path extracted from the web request.
     * @returns The parsed path using the match pattern and the substitution.
     */
    public parseCustomPath(path: string): string {
        // Perform the substitution and return
        const {REWRITE_MATCH_PATTERN, REWRITE_SUBSTITUTION} = process.env;

        if (path === undefined) {
            throw new Error('ThumborMapping::ParseCustomPath::PathUndefined');
        } else if (REWRITE_MATCH_PATTERN === undefined) {
            throw new Error('ThumborMapping::ParseCustomPath::RewriteMatchPatternUndefined');
        } else if (REWRITE_SUBSTITUTION === undefined) {
            throw new Error('ThumborMapping::ParseCustomPath::RewriteSubstitutionUndefined');
        } else {
            let parsedPath;

            if (typeof REWRITE_MATCH_PATTERN === 'string') {
                const patternStrings = REWRITE_MATCH_PATTERN.split('/');
                const flags = patternStrings.pop();
                const parsedPatternString = REWRITE_MATCH_PATTERN.slice(1, REWRITE_MATCH_PATTERN.length - 1 - flags.length);
                const regExp = new RegExp(parsedPatternString, flags);
                parsedPath = path.replace(regExp, REWRITE_SUBSTITUTION);
            } else {
                parsedPath = path.replace(REWRITE_MATCH_PATTERN, REWRITE_SUBSTITUTION);
            }

            return parsedPath;
        }
    }

    /**
     * Scanner function for matching supported Thumbor filters and converting their capabilities into sharp.js supported operations.
     * @param filterExpression The URL path filter.
     * @param fileFormat The file type of the original image.
     * @param previousEdits Cumulative edit, to take into account the previous filters, i.g. `stretch` uses `resize.fit` to make a right update.
     * @returns Cumulative edits based on the previous edits and the current filter.
     */
    public mapFilter(filterExpression: string, fileFormat: ImageFormatTypes, previousEdits: ImageEdits = {}): ImageEdits {
        const filter = filterExpression.replace('filters:', '').replace(')', '');
        const [filterName, filterValue] = filter.split('(');
        const currentEdits = {...previousEdits};

        // Find the proper filter
        switch (filterName) {
            case 'autojpg': {
                currentEdits.toFormat = ImageFormatTypes.JPEG;
                break;
            }
            case 'background_color': {
                const color = !ColorName[filterValue] ? `#${filterValue}` : filterValue;

                currentEdits.flatten = {background: Color(color).object()};
                break;
            }
            case 'blur': {
                const [radius, sigma] = filterValue.split(',').map(x => (x === '' ? NaN : Number(x)));
                currentEdits.blur = !isNaN(sigma) ? sigma : radius / 2;
                break;
            }
            case 'convolution': {
                const values = filterValue.split(',');
                const matrix = values[0].split(';').map(str => Number(str));
                const matrixWidth = Number(values[1]);
                let matrixHeight = 0;
                let counter = 0;

                for (let i = 0; i < matrix.length; i++) {
                    if (counter === matrixWidth - 1) {
                        matrixHeight++;
                        counter = 0;
                    } else {
                        counter++;
                    }
                }

                currentEdits.convolve = {
                    width: matrixWidth,
                    height: matrixHeight,
                    kernel: matrix
                };
                break;
            }
            case 'equalize': {
                currentEdits.normalize = true;
                break;
            }
            case 'fill': {
                if (currentEdits.resize === undefined) {
                    currentEdits.resize = {};
                }

                let color = filterValue;
                if (!ColorName[color]) {
                    color = `#${color}`;
                }

                currentEdits.resize.fit = ImageFitTypes.CONTAIN;
                currentEdits.resize.background = Color(color).object();
                break;
            }
            case 'focal': {
                let width = 0;
                let height = 0;
                if (currentEdits.resize !== undefined) {
                    if (currentEdits.resize.width !== undefined && currentEdits.resize.width !== 0) {
                        width = currentEdits.resize.width;
                    }
                    if (currentEdits.resize.height !== undefined && currentEdits.resize.height !== 0) {
                        height = currentEdits.resize.height;
                    }
                }
                currentEdits.crop = this.mapFocal(filterValue, width, height).crop;
                break;
            }
            case 'format': {
                const imageFormatType = filterValue.replace(/[^0-9a-z]/gi, '').replace(/jpg/i, 'jpeg') as ImageFormatTypes;
                const acceptedValues = [
                    ImageFormatTypes.HEIC,
                    ImageFormatTypes.HEIF,
                    ImageFormatTypes.JPEG,
                    ImageFormatTypes.PNG,
                    ImageFormatTypes.RAW,
                    ImageFormatTypes.TIFF,
                    ImageFormatTypes.WEBP
                ];

                if (acceptedValues.includes(imageFormatType)) {
                    currentEdits.toFormat = imageFormatType;
                }
                break;
            }
            case 'grayscale': {
                currentEdits.grayscale = true;
                break;
            }
            case 'no_upscale': {
                if (currentEdits.resize === undefined) {
                    currentEdits.resize = {};
                }

                currentEdits.resize.withoutEnlargement = true;
                break;
            }
            case 'proportion': {
                if (currentEdits.resize === undefined) {
                    currentEdits.resize = {};
                }
                const ratio = Number(filterValue);

                currentEdits.resize.width = Number(currentEdits.resize.width * ratio);
                currentEdits.resize.height = Number(currentEdits.resize.height * ratio);
                break;
            }
            case 'quality': {
                const toSupportedImageFormatType = (format: ImageFormatTypes): ImageFormatTypes =>
                    [ImageFormatTypes.JPG, ImageFormatTypes.JPEG].includes(format)
                        ? ImageFormatTypes.JPEG
                        : [ImageFormatTypes.PNG, ImageFormatTypes.WEBP, ImageFormatTypes.TIFF, ImageFormatTypes.HEIF].includes(format)
                            ? format
                            : null;

                // trying to get a target image type base on `fileFormat` passed to the current method.
                // if we cannot get the target format, then trying to get the target format from `format` filter.
                const targetImageFileFormat = toSupportedImageFormatType(fileFormat) ?? toSupportedImageFormatType(currentEdits.toFormat);

                if (targetImageFileFormat) {
                    currentEdits[targetImageFileFormat] = {quality: Number(filterValue)};
                }
                break;
            }
            case 'rgb': {
                const percentages = filterValue.split(',');
                const values = percentages.map(percentage => 255 * (Number(percentage) / 100));
                const [r, g, b] = values;

                currentEdits.tint = {r, g, b};
                break;
            }
            case 'rotate': {
                currentEdits.rotate = Number(filterValue);
                break;
            }
            case 'sharpen': {
                const values = filterValue.split(',');

                currentEdits.sharpen = 1 + Number(values[1]) / 2;
                break;
            }
            case 'stretch': {
                if (currentEdits.resize === undefined) {
                    currentEdits.resize = {};
                }

                // If fit-in is not defined, fit parameter would be 'fill'.
                if (currentEdits.resize.fit !== ImageFitTypes.INSIDE) {
                    currentEdits.resize.fit = ImageFitTypes.FILL;
                }
                break;
            }
            case 'strip_exif':
            case 'strip_icc': {
                currentEdits.rotate = null;
                break;
            }
            case 'upscale': {
                if (currentEdits.resize === undefined) {
                    currentEdits.resize = {};
                }

                currentEdits.resize.fit = ImageFitTypes.INSIDE;
                break;
            }
            case 'watermark': {
                const options = filterValue.replace(/\s+/g, '').split(',');
                const [bucket, key, xPos, yPos, alpha, wRatio, hRatio] = options;

                currentEdits.overlayWith = {
                    bucket,
                    key,
                    alpha,
                    wRatio,
                    hRatio,
                    options: {}
                };

                const allowedPosPattern = /^(100|[1-9]?[0-9]|-(100|[1-9][0-9]?))p$/;
                if (allowedPosPattern.test(xPos) || !isNaN(Number(xPos))) {
                    currentEdits.overlayWith.options.left = xPos;
                }
                if (allowedPosPattern.test(yPos) || !isNaN(Number(yPos))) {
                    currentEdits.overlayWith.options.top = yPos;
                }
                break;
            }
        }

        return currentEdits;
    }

    /**
     * Maps the image path to crop image edit.
     * @param crop crop dimensions
     * @returns image edits associated with crop.
     */
    private mapCrop(crop: string): ImageEdits {
        if (crop !== '') {
            const [leftTopPoint, rightBottomPoint] = crop.split(':');
            const [leftTopX, leftTopY] = leftTopPoint.split('x').map(x => parseInt(x, 10));
            const [rightBottomX, rightBottomY] = rightBottomPoint.split('x').map(x => parseInt(x, 10));

            if (!isNaN(leftTopX) && !isNaN(leftTopY) && !isNaN(rightBottomX) && !isNaN(rightBottomY)) {
                return {
                    crop: {
                        left: leftTopX,
                        top: leftTopY,
                        width: rightBottomX - leftTopX,
                        height: rightBottomY - leftTopY
                    }
                };
            }
        }

        return ThumborMapper.EMPTY_IMAGE_EDITS;
    }

    private mapFocal(focal: string, width: number, height: number): ImageEdits {
        if (focal !== '') {
            const [leftTopPoint, rightBottomPoint] = focal.split(':');
            const [leftTopX, leftTopY] = leftTopPoint.split('x').map(x => parseInt(x, 10));
            const [rightBottomX, rightBottomY] = rightBottomPoint.split('x').map(x => parseInt(x, 10));

            if (!isNaN(leftTopX) && !isNaN(leftTopY) && !isNaN(rightBottomX) && !isNaN(rightBottomY)) {
                let widthCenter = (rightBottomX - leftTopX) / 2;
                let heightCenter = (rightBottomY - leftTopY) / 2;
                if (width === 0) {
                    width = rightBottomX - leftTopX;
                }
                if (height === 0) {
                    height = rightBottomY - leftTopY;
                }
                return {
                    crop: {
                        left: widthCenter - (width / 2),
                        top: heightCenter - (height / 2),
                        width: width,
                        height: height
                    }
                };
            }
        }

        return ThumborMapper.EMPTY_IMAGE_EDITS;
    }

    /**
     * Allows the use of smart cropping.
     * @param smart Whether to use smart cropping.
     * @returns Image edits associated with smart cropping.
     */
    private mapSmartCrop(smart: string) {
        const pathSmartMatchResult = smart === 'smart';
        if (pathSmartMatchResult) {
            return {smartCrop: true};
        }
        return ThumborMapper.EMPTY_IMAGE_EDITS;
    }

    /**
     * Maps the image path to resize image edit.
     * @param resize Desired image dimensions.
     * @param position Optional position to focus.
     * @param crop Optional crop points.
     * @param filters Optional filters to check for focal points.
     * @returns Image edits associated with resize.
     */
    private mapResize(resize: string, position: string, crop: string, filters: string): ImageEdits {
        let resizeEdit: {[k: string]: any} = {resize: {}};
        let isValid = false;

        // Process the dimensions
        const dimensionsMatchResult = resize.match(/\d+x\d+/);
        const positionMatchResult = position.match(/position\(.*\)/);

        if (dimensionsMatchResult) {
            // Assign dimensions from the first match only to avoid parsing dimension from image file names
            const [width, height] = dimensionsMatchResult[0]
                .split('x')
                .map(x => parseInt(x));

            // Set only if the dimensions provided are valid
            if (!isNaN(width) && !isNaN(height)) {
                // If width or height is 0, fit would be inside.
                if (width === 0 || height === 0 || crop !== '' || filters.includes('focal(')) {
                    resizeEdit.resize.fit = ImageFitTypes.INSIDE;
                }

                resizeEdit.resize.width = width === 0 ? null : width;
                resizeEdit.resize.height = height === 0 ? null : height;

                isValid = true;
            }

            if (positionMatchResult) {
                resizeEdit.resize.position = positionMatchResult[0].replace('position(', '').replace(')', '');
                isValid = true;
            }
        }

        return isValid ? resizeEdit : ThumborMapper.EMPTY_IMAGE_EDITS;
    }

    /**
     * Maps the image path to fit image edit.
     * @param fit Fit-In to convert.
     * @returns Image edits associated with fit-in filter.
     */
    private mapFitIn(fit: string): ImageEdits {
        return fit.includes('fit-in') ? {resize: {fit: ImageFitTypes.INSIDE}} : ThumborMapper.EMPTY_IMAGE_EDITS;
    }

    /**
     * A helper method to merge edits.
     * @param edits Edits to merge.
     * @returns Merged edits.
     */
    private mergeEdits(...edits: ImageEdits[]) {
        return edits.reduce((result, current) => {
            Object.keys(current).forEach(key => {
                if (Array.isArray(result[key]) && Array.isArray(current[key])) {
                    result[key] = Array.from(new Set(result[key].concat(current[key])));
                } else if (this.isObject(result[key]) && this.isObject(current[key])) {
                    result[key] = this.mergeEdits(result[key], current[key]);
                } else {
                    result[key] = current[key];
                }
            });

            return result;
        }, {}) as ImageEdits;
    }

    /**
     * A helper method to check whether a passed argument is object or not.
     * @param obj Object to check.
     * @returns Whether or not a passed argument is object.
     */
    private isObject(obj: unknown): boolean {
        return obj && typeof obj === 'object' && !Array.isArray(obj);
    }
}
