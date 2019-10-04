// This function is invoked at the start of a state machine execution, and
// ingests the source file declared in the job to a short-term S3 bucket.
// Subsequent states in the step function access the file from that location.
// Source files can be ingested from either S3 or HTTP origins.
//
// The input for this state is the original job object that was sent as input
// to the state machine execution, eg:
// { "Job": { "Id": "xyz", "Source": { "URI": "s3://myBucket/myObject" }, … } }
//
// The input path for this Lambda function is explicitly defined parameters, eg
// { "Job": { "Source": { "URI": "s3://myBucket/myObject" } }, "Execution": { "Id": "x85a61ed-ff52-5291-debd-616797212639" } }
//
// The function returns an object like
// { "BucketName": "abc", "ObjectKey": "xyz" }
//
// The result path is $.Artifact, so the output of the state looks like
// { "Job": { … }, "Artifact": { "BucketName": "abc", "ObjectKey": "xyz" } }

const path = require('path');
const os = require('os');
const fs = require('fs');
const url = require('url');
const AWSXRay = require('aws-xray-sdk');

const http = AWSXRay.captureHTTPs(require('http'));
const https = AWSXRay.captureHTTPs(require('https'));
const AWS = AWSXRay.captureAWS(require('aws-sdk'));

const s3 = new AWS.S3({ apiVersion: '2006-03-01' });

// Requests a file over HTTP and writes it to disk
function httpGet(uri, file, redirectCount) {
  return new Promise((resolve, reject) => {
    const client = uri.toLowerCase().startsWith('https') ? https : http;

    client.get(uri, async (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        try {
          if (redirectCount > 10) {
            reject(new Error('Too many redirects'));
          }

          console.log(`Following redirect: ${res.headers.location}`);
          const count = redirectCount ? (redirectCount + 1) : 1;
          await httpGet(res.headers.location, file, count);
          resolve();
        } catch (error) {
          reject(error);
        }
      } else if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log('Successful HTTP 2XX response');
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', (error) => {
          fs.unlinkSync(file);
          reject(error);
        });

        res.pipe(file);
      } else {
        reject(new Error(`HTTP request failed with code ${res.statusCode}`));
      }
    }).on('error', error => reject(error));
  });
}

function filenameFromSource(source) {
  if (source.Mode === 'HTTP') {
    const urlObj = url.parse(source.URL);
    return urlObj.pathname.split('/').pop() || urlObj.hostname;
  } else if (source.Mode === 'AWS/S3') {
    return source.ObjectKey.split('/').pop();
  }
}
exports.filenameFromSource = filenameFromSource;

exports.handler = async (event, context) => {
  const sourceFilename = filenameFromSource(event.Job.Source);

  const artifactBucketName = process.env.ARTIFACT_BUCKET_NAME;
  const artifactObjectKey = `${event.Execution.Id}/${context.awsRequestId}/${sourceFilename}`;

  if (event.Job.Source.Mode === 'HTTP') {
    // Downloads the HTTP resource to a file on disk in the Lambda's tmp
    // directory, and then uploads that file to the S3 artifact bucket.
    const localFilePath = path.join(os.tmpdir(), sourceFilename);

    const localFile = fs.createWriteStream(localFilePath);
    await httpGet(event.Job.Source.URL, localFile);

    await s3.upload({
      Bucket: artifactBucketName,
      Key: artifactObjectKey,
      Body: fs.createReadStream(localFilePath),
    }).promise();

    fs.unlinkSync(localFilePath);
  } else if (event.Job.Source.Mode === 'AWS/S3') {
    // Copies an existing S3 object to the S3 artifact bucket.
    // https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#copyObject-property
    // https://docs.aws.amazon.com/AmazonS3/latest/API/RESTObjectCOPY.html
    // CopySource expects: "/sourcebucket/path/to/object.extension"
    await s3.copyObject({
      CopySource: `/${event.Job.Source.BucketName}/${event.Job.Source.ObjectKey}`,
      Bucket: artifactBucketName,
      Key: artifactObjectKey
    }).promise();
  } else {
    throw new Error('Unexpected source mode');
  }

  return { 'BucketName': artifactBucketName, 'ObjectKey': artifactObjectKey };
};
