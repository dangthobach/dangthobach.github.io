---
Created by: Bách Đặng Thọ
Created time: 2025-08-31T00:22
---
_Disclaimer: The details in this post have been derived from the official documentation shared online by the Uber Eats Engineering Team. All credit for the technical details goes to the Uber Eats Engineering Team.  The links to the original articles and sources are present in the references section at the end of the post. We’ve attempted to analyze the details and provide our input about them. If you find any inaccuracies or omissions, please leave a comment, and we will do our best to fix them._

At the scale of Uber Eats, image handling is an operational necessity. The platform manages hundreds of millions of product images, with millions of updates flowing through the system every hour. Every image carries cost: network bandwidth, processing time, storage space, and CDN footprint.

As Uber Eats expanded beyond restaurants into groceries, alcohol, and household items, the image pipeline started to strain. For example, a single product, like a can of Coca-Cola, might appear across thousands of storefronts. However, the backend treated each appearance as a fresh upload. There was no concept of shared assets across merchants. Each upload triggered a new download, a new transformation, and a new storage operation, even when the image was identical to one already in the system.

The old approach also assumed that a URL change would accompany any image change. It didn’t track content updates if the URL stayed the same. This blocked image refreshes, resulting in awkward workarounds.

The engineering goal was clear: reduce unnecessary processing, cut down storage and CDN costs, and reuse existing work wherever possible. In this article, we will look at how Uber achieved this goal of de-duplicating hundreds of millions of images.

## **The Limitations of the Old System**

The original image pipeline operated on a simple assumption: if the URL is new, the image must be new. If the URL is the same, skip everything.

However, there was no mechanism to detect whether two different URLs pointed to the same image. The system treated every incoming URL as unique, even if the underlying image bytes were identical. As a result, the same image, uploaded by different merchants or listed in different contexts, would be downloaded, processed, and stored multiple times.

See the diagram below:

[![](https://substackcdn.com/image/fetch/$s_!LXXs!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fc2eb9021-b0d2-4539-acea-a6c9ee6445c0_1600x948.png)](https://substackcdn.com/image/fetch/$s_!LXXs!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2Fc2eb9021-b0d2-4539-acea-a6c9ee6445c0_1600x948.png)

Even worse, the system couldn’t detect content changes when the URL stayed constant. If a merchant updated an image without modifying the URL, the system ignored it entirely. There was no validation, no reprocessing, no cache invalidation.

This had a few major disadvantages:

- Redundant image downloads bloated network usage.

- Unnecessary processing cycles drove up compute costs.

- Duplicate CDN entries pushed storage and delivery costs higher.

## **The New Image Pipeline**

The redesigned image pipeline shifts focus from URLs to actual image content.

Instead of relying on external signals like URL changes, the system now uses content-addressable caching. Every image is identified by a cryptographic hash of its bytes. If two images are identical, their hashes match, regardless of where they came from or what URL they used.

This change enables the system to reuse work across uploads, merchants, and catalog updates without relying on fragile assumptions.

The new image service follows three main paths, depending on what it knows about the image:

- **Known and already processed:** Lookup the image hash and the processing spec. If both are cached, return the processed image immediately.

- **New and unprocessed:** Download the image, compute the hash, apply the transformation, store the result, and return it.

- **Known but not yet processed with current spec:** Retrieve the original image using its hash, apply the requested processing, and store the output.

See the diagram below that shows the three flows:

[![](https://substackcdn.com/image/fetch/$s_!KMb2!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F234b2a87-7aa3-4569-971f-48c7794a1df0_1600x837.png)](https://substackcdn.com/image/fetch/$s_!KMb2!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F234b2a87-7aa3-4569-971f-48c7794a1df0_1600x837.png)

To support these flows, the system maintains three logical maps as shown in the diagram below:

[![](https://substackcdn.com/image/fetch/$s_!Acl3!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F3c14cb4d-d171-4bf6-a1fb-535b8b6add11_1600x777.png)](https://substackcdn.com/image/fetch/$s_!Acl3!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F3c14cb4d-d171-4bf6-a1fb-535b8b6add11_1600x777.png)

Each map handles a distinct concern: identifying content, linking processed outputs, and tracking raw assets.

The storage details are as follows:

- Images, both originals and processed variants, are stored in Terrablob, Uber’s blob storage system modeled after Amazon S3.

- Metadata, such as mappings and processing specs, is stored in Docstore, a document-based key-value store optimized for fast lookups.

## **Processing Specifications**

Every image transformation request includes a processing specification that defines exactly how the image should be handled. This includes:

- Input constraints, such as minimum resolution or acceptable file types.

- Output format, like JPEG or PNG.

- Resizing instructions, including target dimensions or aspect ratio.

Together, the image hash and the processing spec form a unique key. If that combination has been processed before, the system can return the result immediately without doing any work. This caching mechanism applies equally to successful transformations and known failures.

Errors are treated as first-class results. For example, if an uploaded image is too small to meet the requested resolution, the system logs the failure in the Processed Image Map using the same hash-plus-spec key. The next time that image comes in with the same spec, the system skips the download and transformation and returns the cached error.

This avoids repeated failures on the same bad input and prevents wasted compute cycles on requests that are guaranteed to fail. It also makes error reporting faster and more consistent across clients.

## **Handling Image Updates Behind Stable URLs**

Not every image update comes with a new URL. Merchants often replace the content behind a URL without changing the URL itself. In the old system, this meant updates were silently ignored. The system assumed that a known URL always pointed to the same image, which led to stale or incorrect data being served.

To solve this, the new pipeline uses the HTTP Last-Modified header to detect whether an image has changed behind the same URL. During image processing:

- The system checks the stored last-modified value from the **URL Map**.

- It compares this to the current Last-Modified value returned by the image server.

- If the timestamp has changed, the image is re-downloaded and rehashed.

- If the timestamp is the same, the system uses the cached hash and skips the download.

See the diagram below:

[![](https://substackcdn.com/image/fetch/$s_!fYQl!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F16563ebc-e4ec-49ce-a3d4-c70607248454_1600x966.png)](https://substackcdn.com/image/fetch/$s_!fYQl!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F16563ebc-e4ec-49ce-a3d4-c70607248454_1600x966.png)

This approach allows merchants to maintain stable URLs while still delivering updated content. The image pipeline respects those updates without blindly reprocessing every request. It also avoids unnecessary work when nothing has changed.

## **Conclusion**

The new content-addressable image pipeline transformed a noisy, redundant workflow into a lean, high-throughput system.

- With a median latency of 100 milliseconds and P90 under 500 milliseconds, it serves images quickly even under heavy load.

- More than 99 percent of requests are now completed without reprocessing the image. This is a clear win for performance and efficiency.

By deduplicating at the content level, the system avoids repeated downloads, transformations, and storage. It handles image updates gracefully, even when merchants reuse URLs. These changes significantly reduced infrastructure demands while improving reliability.

Perhaps most impressive is the speed of delivery. The new architecture rolled out in under two months, yet supports one of Uber Eats’ highest-volume data paths.

It’s a strong example of how targeted improvements in core systems can unlock broader product velocity, especially when the solution is fast, scalable, and simple to reason about.

**References:**

- [Deduping and Storing Images at Uber Eats](https://www.uber.com/en-IN/blog/deduping-and-storing-images-at-uber-eats/)

- [Evolving schemaless into a Distributed SQL Database](https://www.uber.com/en-IN/blog/schemaless-sql-database/)