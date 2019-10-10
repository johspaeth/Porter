#!/bin/bash

export AWS_PROFILE=prx_legacy
export AWS_DEFAULT_REGION=us-east-1

state_machine_arn="arn:aws:states:us-east-1:561178107736:stateMachine:StateMachine-cvPVX5enHWdj"
ts=$(date +%s)

generate_input() {
read -r -d '' input_json << EOM
    {
        "Job": {
            "Id": "1234567890asdfghjkl-$2",
            "Source": {
                "Mode": "AWS/S3",
                "BucketName": "farski-sandbox-prx",
                "ObjectKey": "podcast.wav"
            },
            "Transcode": {
                "Encodings": [
                    {
                        "Format": "mp4",
                        "Destination": {
                            "Mode": "AWS/S3",
                            "BucketName": "farski-sandbox-prx",
                            "ObjectKey": "rexif-output/transcode-task/$1-$2.mp4"
                        }
                    }
                ]
            }
        }
    }
EOM

echo "$input_json"
}

start_execution() {
    input_json=`generate_input "$ts" "$1"`
    aws stepfunctions start-execution --state-machine-arn "$state_machine_arn" --input "$input_json"
}

i="0"
while [ $i -lt 1 ]
do
    start_execution "$i"
    i=$[$i+1]
done