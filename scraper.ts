// Parses the development applications at the South Australian Wattle Range Council web site and
// places them in a database.
//
// Michael Bone
// 20th October 2018

"use strict";

import * as fs from "fs";
import * as cheerio from "cheerio";
import * as request from "request-promise-native";
import * as sqlite3 from "sqlite3";
import * as urlparser from "url";
import * as moment from "moment";
import * as pdfjs from "pdfjs-dist";
import * as didyoumean from "didyoumean2";

sqlite3.verbose();

const DevelopmentApplicationsUrl = "https://www.wattlerange.sa.gov.au/page.aspx?u=1158";
const CommentUrl = "mailto:council@wattlerange.sa.gov.au";

declare const process: any;

// All valid suburb names.

let SuburbNames = null;

// Sets up an sqlite database.

async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        let database = new sqlite3.Database("data.sqlite");
        database.serialize(() => {
            database.run("create table if not exists [data] ([council_reference] text primary key, [address] text, [description] text, [info_url] text, [comment_url] text, [date_scraped] text, [date_received] text)");
            resolve(database);
        });
    });
}

// Inserts a row in the database if it does not already exist.

async function insertRow(database, developmentApplication) {
    return new Promise((resolve, reject) => {
        let sqlStatement = database.prepare("insert or ignore into [data] values (?, ?, ?, ?, ?, ?, ?)");
        sqlStatement.run([
            developmentApplication.applicationNumber,
            developmentApplication.address,
            developmentApplication.description,
            developmentApplication.informationUrl,
            developmentApplication.commentUrl,
            developmentApplication.scrapeDate,
            developmentApplication.receivedDate
        ], function(error, row) {
            if (error) {
                console.error(error);
                reject(error);
            } else {
                if (this.changes > 0)
                    console.log(`    Inserted: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\" and received date \"${developmentApplication.receivedDate}\" into the database.`);
                else
                    console.log(`    Skipped: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\", description \"${developmentApplication.description}\" and received date \"${developmentApplication.receivedDate}\" because it was already present in the database.`);
                sqlStatement.finalize();  // releases any locks
                resolve(row);
            }
        });
    });
}

// A 2D point.

interface Point {
    x: number,
    y: number
}

// A bounding rectangle.

interface Rectangle {
    x: number,
    y: number,
    width: number,
    height: number
}

// An element (consisting of text and intersecting cells) in a PDF document.

interface Element extends Rectangle {
    text: string
}

// A cell in a grid (owning zero, one or more elements).

interface Cell extends Rectangle {
    elements: Element[]
}

// Gets the highest Y co-ordinate of all elements that are considered to be in the same row as
// the specified element.  Take care to avoid extremely tall elements (because these may otherwise
// be considered as part of all rows and effectively force the return value of this function to
// the same value, regardless of the value of startElement).

function getRowTop(elements: Element[], startElement: Element) {
    let top = startElement.y;
    for (let element of elements)
        if (element.y < startElement.y + startElement.height && element.y + element.height > startElement.y)  // check for overlap
            if (getVerticalOverlapPercentage(startElement, element) > 50)  // avoids extremely tall elements
                if (element.y < top)
                    top = element.y;
    return top;
}

// Constructs a rectangle based on the intersection of the two specified rectangles.

function intersect(rectangle1: Rectangle, rectangle2: Rectangle): Rectangle {
    let x1 = Math.max(rectangle1.x, rectangle2.x);
    let y1 = Math.max(rectangle1.y, rectangle2.y);
    let x2 = Math.min(rectangle1.x + rectangle1.width, rectangle2.x + rectangle2.width);
    let y2 = Math.min(rectangle1.y + rectangle1.height, rectangle2.y + rectangle2.height);
    if (x2 >= x1 && y2 >= y1)
        return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    else
        return { x: 0, y: 0, width: 0, height: 0 };
}

// Determines whether containerRectangle completely contains containedRectangle.

function contains(containerRectangle: Rectangle, containedRectangle: Rectangle) {
    return containerRectangle.x <= containedRectangle.x &&
        containerRectangle.y <= containedRectangle.y &&
        containerRectangle.x + containerRectangle.width >= containedRectangle.x + containedRectangle.width &&
        containerRectangle.y + containerRectangle.height >= containedRectangle.y + containedRectangle.height;
}

// Calculates the area of a rectangle.

function getArea(rectangle: Rectangle) {
    return rectangle.width * rectangle.height;
}

// Calculates the square of the Euclidean distance between two elements.

function calculateDistance(element1: Element, element2: Element) {
    let point1 = { x: element1.x + element1.width, y: element1.y + element1.height / 2 };
    let point2 = { x: element2.x, y: element2.y + element2.height / 2 };
    if (point2.x < point1.x - element1.width / 5)  // arbitrary overlap factor of 20% (ie. ignore elements that overlap too much in the horizontal direction)
        return Number.MAX_VALUE;
    return (point2.x - point1.x) ** 2 + (point2.y - point1.y) ** 2;
}

// Determines whether there is vertical overlap between two elements.

function isVerticalOverlap(element1: Element, element2: Element) {
    return element2.y < element1.y + element1.height && element2.y + element2.height > element1.y;
}

// Gets the percentage of vertical overlap between two elements (0 means no overlap and 100 means
// 100% overlap; and, for example, 20 means that 20% of the second element overlaps somewhere
// with the first element).

function getVerticalOverlapPercentage(element1: Element, element2: Element) {
    let y1 = Math.max(element1.y, element2.y);
    let y2 = Math.min(element1.y + element1.height, element2.y + element2.height);
    return (y2 < y1) ? 0 : (((y2 - y1) * 100) / element2.height);
}

// Gets the percentage of horizontal overlap between two rectangles (0 means no overlap and 100
// means 100% overlap).

function getHorizontalOverlapPercentage(rectangle1: Rectangle, rectangle2: Rectangle) {
    if (rectangle1 === undefined || rectangle2 === undefined)
        return 0;

    let startX1 = rectangle1.x;
    let endX1 = rectangle1.x + rectangle1.width;

    let startX2 = rectangle2.x;
    let endX2 = rectangle2.x + rectangle2.width;

    if (startX1 >= endX2 || endX1 <= startX2 || rectangle1.width === 0 || rectangle2.width === 0)
        return 0;

    let intersectionWidth = Math.min(endX1, endX2) - Math.max(startX1, startX2);
    let unionWidth = Math.max(endX1, endX2) - Math.min(startX1, startX2);

    return (intersectionWidth * 100) / unionWidth;
}

// Gets the element immediately to the right of the specified element (but ignores elements that
// appear after a large horizontal gap).

function getRightElement(elements: Element[], element: Element) {
    let closestElement: Element = { text: undefined, x: Number.MAX_VALUE, y: Number.MAX_VALUE, width: 0, height: 0 };
    for (let rightElement of elements)
        if (isVerticalOverlap(element, rightElement) &&  // ensure that there is at least some vertical overlap
            getVerticalOverlapPercentage(element, rightElement) > 50 &&  // avoid extremely tall elements (ensure at least 50% overlap)
            (rightElement.x > element.x + element.width) &&  // ensure the element actually is to the right
            (rightElement.x - (element.x + element.width) < 30) &&  // avoid elements that appear after a large gap (arbitrarily ensure less than a 30 pixel gap horizontally)
            calculateDistance(element, rightElement) < calculateDistance(element, closestElement))  // check if closer than any element encountered so far
            closestElement = rightElement;
    return (closestElement.text === undefined) ? undefined : closestElement;
}

// Formats (and corrects) an address.

function formatAddress(address: string) {
    address = address.trim();
    if (address === "")
        return "";

    // Pop tokens from the end of the array until a valid suburb name is encountered (allowing
    // for a few spelling errors).

    let tokens = address.split(" ");

    let suburbName = null;
    for (let index = 1; index <= 4; index++) {
        let suburbNameMatch = didyoumean(tokens.slice(-index).join(" "), Object.keys(SuburbNames), { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true });
        if (suburbNameMatch !== null) {
            suburbName = SuburbNames[suburbNameMatch];
            tokens.splice(-index, index);  // remove elements from the end of the array           
            break;
        }
    }

    if (suburbName === null) {  // suburb name not found (or not recognised)
        console.log(`The state and post code will not be added because the suburb was not recognised: ${address}`);
        return address;
    }

    // Add the suburb name with its state and post code to the street name.

    let streetName = tokens.join(" ").trim();
    return (streetName + ((streetName === "") ? "" : ", ") + suburbName).trim();
}

// Parses the details from the elements associated with a single development application.

function parseApplicationElements(elements: Element[], startElement: Element, applicantElement: Element, applicationElement: Element, proposalElement: Element, referralsElement: Element, informationUrl: string) {
    // Get the application number.

    let xComparer = (a, b) => (a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0);
    let applicationNumberElements = elements
        .filter(element => element.x < applicantElement.x && element.y < startElement.y + 2 * startElement.height)
        .sort(xComparer);

    let applicationNumber = undefined;
    for (let index = 1; index <= applicationNumberElements.length; index++) {
        let text = applicationNumberElements.slice(0, index).map(element => element.text).join("").replace(/\s/g, "");
        if (/\/[0-9]{4}$/.test(text)) {
            applicationNumber = text;
            break;
        }
    }
    if (applicationNumber === undefined) {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Could not find the application number on the PDF page for the current development application.  The development application will be ignored.  Elements: ${elementSummary}`);
        return undefined;
    }
    console.log(`    Found \"${applicationNumber}\".`);

    // Get the application date element (text to the right of this constitutes the address).

    let applicationDateElement: Element = undefined;
    let applicationDateRectangle : Rectangle = { x: applicationElement.x, y: 0, width: applicationElement.width, height : applicationElement.height };
    for (let element of elements) {
        applicationDateRectangle.y = element.y;
        if (getArea(element) > 0 &&  // ensure a valid element
            getArea(element) > 0.5 * getArea(applicationDateRectangle) &&  // ensure that the element is approximately the same size (within 50%) as what is expected for the date rectangle
            getArea(intersect(element, applicationDateRectangle)) > 0.75 * getArea(element)) {  // determine if the element mostly overlaps (by more than 75%) the rectangle where the date is expected to appear
            applicationDateElement = element;
            break;
        }
    }
    if (applicationDateElement === undefined) {
        let elementSummary = elements.map(element => `[${element.text}]`).join("");
        console.log(`Could not find the application date on the PDF page for the current development application.  The development application will be ignored.  Elements: ${elementSummary}`);
        return undefined;
    }

    // Get the received date.

    let receivedDateElement: Element = undefined;
    let receivedDateRectangle : Rectangle = { x: applicationElement.x, y: 0, width: applicationElement.width, height : applicationElement.height };
    for (let element of elements) {
        receivedDateRectangle.y = element.y;
        if (getArea(element) > 0 &&  // ensure a valid element
            getArea(element) > 0.5 * getArea(receivedDateRectangle) &&  // ensure that the element is approximately the same size (within 50%) as what is expected for the date rectangle
            getArea(intersect(element, receivedDateRectangle)) > 0.75 * getArea(element) &&  // determine if the element mostly overlaps (by more than 75%) the rectangle where the date is expected to appear
            element.y > applicationDateElement.y + applicationDateElement.height &&  // ignore the application date (the recieved date appears futher down)
            moment(element.text.trim(), "D/MM/YYYY", true).isValid()) {  // ensure that "Received" and "Date" text are ignored (keep searching until a valid date is found)
            receivedDateElement = element;
            break;
        }
    }

    if (receivedDateElement === undefined)
        receivedDateElement = applicationDateElement;  // fallback to the application date

    let receivedDate = moment(applicationDateElement.text.trim(), "D/MM/YYYY", true);
    
    // Get the address (to the right of the application date element and to the left of the
    // "Proposal" column heading).  The address seems to always be a single line.

    let address = elements
        .filter(element =>
            element.x > applicationDateElement.x + applicationDateElement.width &&  // the address elements must be to the right of the application date
            getVerticalOverlapPercentage(applicationDateElement, element) > 50 &&  // the address element must overlap vertically with the application date element
            element.x < proposalElement.x - proposalElement.height / 2)  // the address element must be at least a little to the left of the "Proposal" heading text (arbitrarily use half the height)
        .sort(xComparer)
        .map(element => element.text)
        .join("");

    address = formatAddress(address);  // add the state and post code to the address

    // Get the description.

    let description = "";

    if (referralsElement !== undefined) {
        let descriptionElements = elements
            .filter(element =>
                element.x > proposalElement.x - proposalElement.height / 2 &&  // the description elements may start at least a little to the left to the "Proposal" heading
                element.x < referralsElement.x);  // the description elements are to the left of the "Referrals/" heading
        
        let previousY = undefined;
        for (let descriptionElement of descriptionElements) {
            if (previousY !== undefined && descriptionElement.y > previousY + descriptionElement.height / 2)  // a new line
                description += " ";
            description += descriptionElement.text;
            previousY = descriptionElement.y;
        }
    }

    return {
        applicationNumber: applicationNumber,
        address: address,
        description: ((description.trim() === "") ? "No Description Provided" : description),
        informationUrl: informationUrl,
        commentUrl: CommentUrl,
        scrapeDate: moment().format("YYYY-MM-DD"),
        receivedDate: (receivedDate !== undefined && receivedDate.isValid()) ? receivedDate.format("YYYY-MM-DD") : ""
    };
}

// Finds the start element of each development application on the current PDF page (there are
// typically many development applications on a single page and each development application
// typically begins with the text "Lodgement").

function findStartElements(elements: Element[]) {
    // Examine all the elements on the page that being with "L" or "l".
    
    let startElements: Element[] = [];
    for (let element of elements.filter(element => element.text.trim().toLowerCase().startsWith("l"))) {
        // Extract up to 10 elements to the right of the element that has text starting with the
        // letter "l" (and so may be the start of the "Lodgement" text).  Join together the
        // elements to the right in an attempt to find the best match to "Lodgement".

        let rightElement = element;
        let rightElements: Element[] = [];
        let matches = [];

        do {
            rightElements.push(rightElement);
        
            let text = rightElements.map(element => element.text).join("").replace(/\s/g, "").toLowerCase();
            if (text.length >= 10)  // stop once the text is too long
                break;
            if (text.length >= 8) {  // ignore until the text is close to long enough
                if (text === "lodgement")
                    matches.push({ element: rightElement, threshold: 0 });
                else if (didyoumean(text, [ "Lodgement" ], { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 1, trimSpace: true }) !== null)
                    matches.push({ element: rightElement, threshold: 1 });
                else if (didyoumean(text, [ "Lodgement" ], { caseSensitive: false, returnType: "first-closest-match", thresholdType: "edit-distance", threshold: 2, trimSpace: true }) !== null)
                    matches.push({ element: rightElement, threshold: 2 });
            }

            rightElement = getRightElement(elements, rightElement);
        } while (rightElement !== undefined && rightElements.length < 10);

        // Chose the best match (if any matches were found).

        if (matches.length > 0) {
            let bestMatch = matches.reduce((previous, current) =>
                (previous === undefined ||
                previous.threshold < current.threshold ||
                (previous.threshold === current.threshold && Math.abs(previous.text.length - "Lodgement".length) <= Math.abs(current.text.length - "Lodgement".length)) ? current : previous), undefined);
            startElements.push(bestMatch.element);
        }
    }

    // Ensure the start elements are sorted in the order that they appear on the page.

    let yComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : 0);
    startElements.sort(yComparer);
    return startElements;
}

// Parses a PDF document.

async function parsePdf(url: string) {
    let developmentApplications = [];

    // Read the PDF.

    let buffer = await request({ url: url, encoding: null, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);

    // Parse the PDF.  Each page has the details of multiple applications.

    let pdf = await pdfjs.getDocument({ data: buffer, disableFontFace: true, ignoreErrors: true });
    for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex++) {
        console.log(`Reading and parsing applications from page ${pageIndex + 1} of ${pdf.numPages}.`);
        let page = await pdf.getPage(pageIndex + 1);

        // Construct a text element for each item from the parsed PDF information.

        let viewport = await page.getViewport(1.0);
        let textContent = await page.getTextContent();
        let operators = await page.getOperatorList();

        // Find the lines.  Each line is actually constructed using a rectangle with a very short
        // height or a  very narrow width.

        let lines: Rectangle[] = [];

        for (let index = 0; index < operators.fnArray.length; index++) {
            if (operators.fnArray[index] !== pdfjs.OPS.constructPath)
                continue;
            let x = operators.argsArray[index][1][1];
            let y = operators.argsArray[index][1][0];
            let width = operators.argsArray[index][1][3];
            let height = operators.argsArray[index][1][2];

            lines.push({x: x, y: y, width: width, height: height});

            // console.log(`            Draw(e.Graphics, ${x}f, ${y}f, ${width}f, ${height}f);`);
        }

        // Convert the lines into a grid of points.

        let points: Point[] = [];

        for (let line of lines) {
            // Ignore thick lines (since these are probably intented to be drawn as rectangles).
            // And ignore short lines (because these are probably of no consequence).

            if ((line.width > 2 && line.height > 2) || (line.width <= 2 && line.height < 10) || (line.height <= 2 && line.width < 10))
                continue;

            let startPoint: Point = { x: line.x, y: line.y };
            if (!points.some(point => (startPoint.x - point.x) ** 2 + (startPoint.y - point.y) ** 2 < 1))
                points.push(startPoint);

            let endPoint: Point = undefined;
            if (line.height <= 2)  // horizontal line
                endPoint = { x: line.x + line.width, y: line.y };
            else  // vertical line
                endPoint = { x: line.x, y: line.y + line.height };

            if (!points.some(point => (endPoint.x - point.x) ** 2 + (endPoint.y - point.y) ** 2 < 1))
                points.push(endPoint);
        }

        for (let point of points)
            console.log(`            DrawPoint(e.Graphics, ${point.x}f, ${point.y}f);`);

        // Construct cells based on the grid of points.

        let cells: Cell[] = [];
        for (let point of points) {
            // Find the next closest point in the X direction (moving across horizontally with
            // approximately the same Y co-ordinate).

            let closestRightPoint = points.reduce(
                ((previous, current) => (Math.abs(current.y - point.y) < 1 && current.x > point.x && (previous === undefined || (current.x - point.x < previous.x - point.x))) ? current : previous),
                undefined);

            // Find the next closest point in the Y direction (moving down vertically with
            // approximately the same X co-ordinate).

            let closestDownPoint = points.reduce(
                ((previous, current) => (Math.abs(current.x - point.x) < 1 && current.y > point.y && (previous === undefined || (current.y - point.y < previous.y - point.y))) ? current : previous),
                undefined);

            // Construct a rectangle from the found points.

            if (closestRightPoint !== undefined && closestDownPoint !== undefined) {
                let cell: Cell = { elements: [], x: point.x, y: point.y, width: closestRightPoint.x - point.x, height: closestDownPoint.y - point.y };
                console.log(`            DrawRectangle(e.Graphics, ${cell.x}f, ${cell.y}f, ${cell.width}f, ${cell.height}f);`);
                cells.push(cell);
            }
        }

        // Sort the cells by approximate Y co-ordinate and then by X co-ordinate.

        let cellComparer = (a, b) => (Math.abs(a.y - b.y) < 2) ? ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)) : ((a.y > b.y) ? 1 : -1);
        cells.sort(cellComparer);

        // Find all the text elements.

        let elements: Element[] = textContent.items.map(item => {
            let transform = pdfjs.Util.transform(viewport.transform, item.transform);

            // Work around the issue https://github.com/mozilla/pdf.js/issues/8276 (heights are
            // exaggerated).  The problem seems to be that the height value is too large in some
            // PDFs.  Provide an alternative, more accurate height value by using a calculation
            // based on the transform matrix.

            let workaroundHeight = Math.sqrt(transform[2] * transform[2] + transform[3] * transform[3]);

            let x = transform[4];
            let y = transform[5] - workaroundHeight;
            let width = item.width;
            let height = workaroundHeight;
console.log(`            DrawText(e.Graphics, "${item.str}", ${x}f, ${y}f, ${width}f, ${height}f);`);

            return { text: item.str, x: x, y: y, width: width, height: height };
        });

        // Sort the text elements by approximate Y co-ordinate and then by X co-ordinate.

        let elementComparer = (a, b) => (Math.abs(a.y - b.y) < 1) ? ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)) : ((a.y > b.y) ? 1 : -1);
        elements.sort(elementComparer);

        // Allocate each element to an "owning" cell.  An element may extend across several
        // cells (because the PDF parsing may join together multiple sections of text, using
        // multiple intervening spaces; see addFakeSpaces in pdf.worker.js of pdf.js).  If
        // there are multiple cells then allocate the element to the left most cell.

        for (let element of elements) {
            let ownerCell = cells.find(cell => getArea(intersect(cell, element)) > 0);  // this finds the left most cell due to the earlier sorting of cells
            if (ownerCell !== undefined)
                ownerCell.elements.push(element);
        }

        // Group the cells into rows.

        let rows: Rectangle[][] = [];

        for (let cell of cells) {
            let row = rows.find(row => Math.abs(row[0].y - cell.y) < 2);  // approximate Y co-ordinate match
            if (row === undefined)
                rows.push([ cell ]);  // start a new row
            else
                row.push(cell);  // add to an existing row
        }

        // Ensure the rows are sorted by Y co-ordinate and that  the cells in each row are sorted
        // by X co-ordinate (this is just a safety precaution because the earlier sorting of cells
        // should have already ensured this).

        let rowComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : 0);
        rows.sort(rowComparer);

        let rowCellComparer = (a, b) => (a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0);
        for (let row of rows)
            row.sort(rowCellComparer);

        // Find the heading cells.

        let assessmentCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "ASSESS" && contains(cell, element)));
        let vgNumberCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "VG NUMBER" && contains(cell, element)));
        let applicationNumberCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "DA NUMBER" && contains(cell, element)));
        let applicantCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "APPLICANT" && contains(cell, element)));
        let ownerCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "OWNER" && contains(cell, element)));
        let builderCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "BUILDER" && contains(cell, element)));
        let addressCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "LOCATION" && contains(cell, element)));
        let descriptionCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "DESCRIPTION" && contains(cell, element)));
        let decisionDateCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "DECISION" && contains(cell, element)));
        let valuationCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "VALUATION" && contains(cell, element)));
        let areaCell = cells.find(cell => cell.elements.some(element => element.text.trim() === "AREA" && contains(cell, element)));

        if (applicationNumberCell === undefined) {
            let elementSummary = elements.map(element => `[${element.text}]`).join("");
            console.log(`No development applications can be parsed from the current page because the "DA NUMBER" column heading was not found.  Elements: ${elementSummary}`);
            continue;
        }

        if (addressCell === undefined) {
            let elementSummary = elements.map(element => `[${element.text}]`).join("");
            console.log(`No development applications can be parsed from the current page because the "LOCATION" column heading was not found.  Elements: ${elementSummary}`);
            continue;
        }

        // Parse any elements that intersect more than one cell.

        for (let cell of cells) {
            for (let element of cell.elements) {  // <-- wrong, could process same element twice
                if (!contains(cell, element)) {  // if element extends outside of the owning cell (perhaps into another cell, perhaps outside of any cell)
                    // Get all elements that have approximately the same Y co-ordinate in the cell.

                    let ambiguousElements = cell.elements.filter(otherElement => Math.abs(otherElement.y - element.y) < 5);
                    let text = ambiguousElements.map(element => element.text).join("");

                    // Parse the text.

                    console.log(text);
                }
            }

            if (cell.elements.some(element => !contains(cell, element))) {
                // Examine each cell that the element intersects.  In most cases determining which
                // column heading the first cell falls under will enable the text to be split and
                // so then allocated to appropriate columns.

                // let firstCell = element.cells[0];
                if (getHorizontalOverlapPercentage(cell, assessmentCell) > 90) {
                    
                } else if (getHorizontalOverlapPercentage(cell, vgNumberCell) > 90) {

                } else if (getHorizontalOverlapPercentage(cell, applicationNumberCell) > 90) {

                } else if (getHorizontalOverlapPercentage(cell, applicantCell) > 90) {

                } else if (getHorizontalOverlapPercentage(cell, ownerCell) > 90) {

                } else if (getHorizontalOverlapPercentage(cell, builderCell) > 90) {
                    
                } else if (getHorizontalOverlapPercentage(cell, addressCell) > 90) {
                    
                } else if (getHorizontalOverlapPercentage(cell, descriptionCell) > 90) {
                    
                } else if (getHorizontalOverlapPercentage(cell, decisionDateCell) > 90) {
                    
                } else if (getHorizontalOverlapPercentage(cell, valuationCell) > 90) {
                    
                } else if (getHorizontalOverlapPercentage(cell, areaCell) > 90) {
                    
                } else {
                    
                }
            }
        }

        // Group the elements into rows.


        // Sort the elements by Y co-ordinate and then by X co-ordinate.
        //
        // let elementComparer = (a, b) => (a.y > b.y) ? 1 : ((a.y < b.y) ? -1 : ((a.x > b.x) ? 1 : ((a.x < b.x) ? -1 : 0)));
        // elements.sort(elementComparer);

        // Ignore the page number (the last element on the page).  Otherwise this will end up as
        // part of a description.
        //
        // if (/[0-9]+/.test(elements[elements.length - 1].text) && Number(elements[elements.length - 1].text) < 1000)
        //     elements.pop();

        // Find the main column heading elements.
        //
        // let applicationElement = elements.find(element => element.text.trim() === "DA NUMBER");
        // let applicantElement = elements.find(element => element.text.trim() === "APPLICANT");
        // let ownerElement = elements.find(element => element.text.trim() === "OWNER");
        // let locationElement = elements.find(element => element.text.trim() === "LOCATION");
        // let descriptionElement = elements.find(element => element.text.trim() === "DESCRIPTION");
        // let decisionElement = elements.find(element => element.text.trim() === "DECISION");
        // let proposalElement = undefined;
        // let referralsElement = undefined;
        
        // if (applicantElement === undefined) {
        //     let elementSummary = elements.map(element => `[${element.text}]`).join("");
        //     console.log(`No development applications can be parsed from the current page because the \"Applicant\" column heading was not found.  Elements: ${elementSummary}`);
        //     continue;
        // } else if (applicationElement === undefined) {
        //     let elementSummary = elements.map(element => `[${element.text}]`).join("");
        //     console.log(`No development applications can be parsed from the current page because the \"Application Date\" column heading was not found.  Elements: ${elementSummary}`);
        //     continue;
        // } else if (proposalElement === undefined) {
        //     let elementSummary = elements.map(element => `[${element.text}]`).join("");
        //     console.log(`No development applications can be parsed from the current page because the \"Proposal\" column heading was not found.  Elements: ${elementSummary}`);
        //     continue;
        // }

        // Group the elements into sections based on where the "Lodgement" text starts (and other
        // elements the "Lodgement" elements line up with horizontally with a margin of error equal
        // to about half the height of the "Lodgement" text).

        let applicationElementGroups = [];
        let startElements = findStartElements(elements);
        for (let index = 0; index < startElements.length; index++) {
            // Determine the highest Y co-ordinate of this row and the next row (or the bottom of
            // the current page).  Allow some leeway vertically (add some extra height).
            
            let startElement = startElements[index];
            let raisedStartElement: Element = {
                text: startElement.text,
                x: startElement.x,
                y: startElement.y - startElement.height / 2,  // leeway
                width: startElement.width,
                height: startElement.height };
            let rowTop = getRowTop(elements, raisedStartElement);
            let nextRowTop = (index + 1 < startElements.length) ? getRowTop(elements, startElements[index + 1]) : Number.MAX_VALUE;

            // Extract all elements between the two rows.

            applicationElementGroups.push({ startElement: startElements[index], elements: elements.filter(element => element.y >= rowTop && element.y + element.height < nextRowTop) });
        }

        // Parse the development application from each group of elements (ie. a section of the
        // current page of the PDF document).  If the same application number is encountered a
        // second time add a suffix to the application number so it is unique (and so will be
        // inserted into the database later instead of being ignored).
        //
        // for (let applicationElementGroup of applicationElementGroups) {
        //     let developmentApplication = parseApplicationElements(applicationElementGroup.elements, applicationElementGroup.startElement, applicantElement, applicationElement, proposalElement, referralsElement, url);
        //     if (developmentApplication !== undefined) {
        //         let suffix = 0;
        //         let applicationNumber = developmentApplication.applicationNumber;
        //         while (developmentApplications
        //             .some(otherDevelopmentApplication =>
        //                 otherDevelopmentApplication.applicationNumber === developmentApplication.applicationNumber &&
        //                     (otherDevelopmentApplication.address !== developmentApplication.address ||
        //                     otherDevelopmentApplication.description !== developmentApplication.description ||
        //                     otherDevelopmentApplication.receivedDate !== developmentApplication.receivedDate)))
        //             developmentApplication.applicationNumber = `${applicationNumber} (${++suffix})`;  // add a unique suffix
        //         developmentApplications.push(developmentApplication);
        //     }
        // }
    }

    return developmentApplications;
}

// Gets a random integer in the specified range: [minimum, maximum).

function getRandom(minimum: number, maximum: number) {
    return Math.floor(Math.random() * (Math.floor(maximum) - Math.ceil(minimum))) + Math.ceil(minimum);
}

// Pauses for the specified number of milliseconds.

function sleep(milliseconds: number) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// Parses the development applications.

async function main() {
    // Ensure that the database exists.

    let database = await initializeDatabase();

    // Read the files containing all possible suburb names.

    SuburbNames = {};
    // for (let suburb of fs.readFileSync("suburbnames.txt").toString().replace(/\r/g, "").trim().split("\n"))
    //     SuburbNames[suburb.split(",")[0]] = suburb.split(",")[1];

    // Retrieve the page that contains the links to the PDFs.

    console.log(`Retrieving page: ${DevelopmentApplicationsUrl}`);

    let body = await request({ url: DevelopmentApplicationsUrl, proxy: process.env.MORPH_PROXY });
    await sleep(2000 + getRandom(0, 5) * 1000);
    let $ = cheerio.load(body);
    
    let pdfUrls: string[] = [];
    for (let element of $("td.u6ListTD a[href$='.pdf']").get()) {
        let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl);
        if (!pdfUrls.some(url => url === pdfUrl.href))  // avoid duplicates
            pdfUrls.push(pdfUrl.href);
    }

    if (pdfUrls.length === 0) {
        console.log("No PDF URLs were found on the page.");
        return;
    }

    pdfUrls.reverse();

    // Select the most recent PDF.  And randomly select one other PDF (avoid processing all PDFs
    // at once because this may use too much memory, resulting in morph.io terminating the current
    // process).

    let selectedPdfUrls: string[] = [];
    selectedPdfUrls.push(pdfUrls.shift());
    if (pdfUrls.length > 0)
        selectedPdfUrls.push(pdfUrls[getRandom(1, pdfUrls.length)]);
    if (getRandom(0, 2) === 0)
        selectedPdfUrls.reverse();

console.log("Testing PDF.");
selectedPdfUrls = [ "https://www.wattlerange.sa.gov.au/webdata/resources/files/Stats%20March%2018.pdf" ];

    for (let pdfUrl of selectedPdfUrls) {
        console.log(`Parsing document: ${pdfUrl}`);
        let developmentApplications = await parsePdf(pdfUrl);
        console.log(`Parsed ${developmentApplications.length} development application(s) from document: ${pdfUrl}`);
        console.log(`Inserting development applications into the database.`);
        for (let developmentApplication of developmentApplications)
            await insertRow(database, developmentApplication);
    }
}

main().then(() => console.log("Complete.")).catch(error => console.error(error));
