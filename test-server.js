const http = require("http");

const server = http.createServer((req, res) => {
    const match = req.url.match(/^(?:\/([a-zA-Z0-9_-]+))?\/page\/(\d+)\/?$/);

    if (match) {
        const namespacePrefix = match[1] ? `/${match[1]}` : "";
        const page = Number(match[2]);

        if (page < 1 || page > 50) {
            res.writeHead(404);
            res.end("Not Found");
            return;
        }

        let html = `
<html>
<head><title>Page ${page}</title></head>
<body>
<h1>Page ${page}</h1>
`;

        for (let i = 1; i <= 5; i++) {
            const nextPage = ((page + i - 1) % 50) + 1;
            html += `<a href="${namespacePrefix}/page/${nextPage}">Page ${nextPage}</a><br>`;
        }

        html += `
</body>
</html>
`;

        res.writeHead(200, {
            "Content-Type": "text/html"
        });

        setTimeout(() => {
            res.end(html);
        }, 1000);

        return;
    }

    res.writeHead(404);
    res.end("Not Found");
});

server.listen(3000, () => {
    console.log("Test server running at http://localhost:3000");
});